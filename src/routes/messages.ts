import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { isBlockedEitherWay } from "../blocks.js";
import { firstUrlInText, unfurlUrl } from "../linkPreview.js";
import { messageTypeFromMime, previewForType } from "../mediaTypes.js";
import {
  buildContactPayload,
  buildEventPayload,
  buildLocationPayload,
  buildPollPayload,
  messageInclude,
  previewForRichType,
  toMessageDto,
} from "../messages.js";
import { requireUser } from "../plugins/auth.js";
import { realtimeHub } from "../realtime/hub.js";
import { notifyNewMessage } from "../push/fcm.js";
import type { MessageType } from "@prisma/client";

async function assertMember(conversationId: string, userId: string) {
  return prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: { conversationId, userId },
    },
  });
}

async function loadMessageDto(id: string, viewerId: string) {
  const msg = await prisma.message.findUnique({
    where: { id },
    include: messageInclude,
  });
  if (!msg) return null;
  return toMessageDto(msg, viewerId);
}

function broadcastMessage(conversationId: string, dto: ReturnType<typeof toMessageDto>, exceptUserId?: string) {
  realtimeHub.toRoom(conversationId, { type: "message", data: dto });
  void prisma.conversationMember
    .findMany({
      where: {
        conversationId,
        ...(exceptUserId ? { userId: { not: exceptUserId } } : {}),
      },
      select: { userId: true },
    })
    .then((peers) => {
      for (const peer of peers) {
        if (!realtimeHub.isInRoom(peer.userId, conversationId)) {
          realtimeHub.toUser(peer.userId, { type: "message", data: dto });
        }
      }
    });
}

async function emitReceipt(
  conversationId: string,
  status: "delivered" | "read",
  messageIds: string[],
) {
  if (messageIds.length === 0) return;
  const frame = {
    type: "receipt" as const,
    data: {
      conversation_id: conversationId,
      message_ids: messageIds,
      message_id: messageIds[0] ?? null,
      status,
    },
  };
  realtimeHub.toRoom(conversationId, frame);
  // Senders who left the room (e.g. on home) still need tick updates.
  const msgs = await prisma.message.findMany({
    where: { id: { in: messageIds } },
    select: { senderId: true },
  });
  const senderIds = [...new Set(msgs.map((m) => m.senderId))];
  for (const senderId of senderIds) {
    if (!realtimeHub.isInRoom(senderId, conversationId)) {
      realtimeHub.toUser(senderId, frame);
    }
  }
}

export async function messageRoutes(app: FastifyInstance) {
  app.get("/api/conversations/:id/messages", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: string; before?: string; q?: string };
    const search = q.q?.trim();
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));

    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    // Latest page by default; `before` (ISO createdAt) loads older. Always return asc for UI.
    const createdAtFilter: { gt?: Date; lt?: Date } = {};
    if (member.clearedAt) createdAtFilter.gt = member.clearedAt;
    if (q.before) createdAtFilter.lt = new Date(q.before);

    const rowsRaw = await prisma.message.findMany({
      where: {
        conversationId: id,
        hides: { none: { userId } },
        deletedForEveryoneAt: search ? null : undefined,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...(Object.keys(createdAtFilter).length ? { createdAt: createdAtFilter } : {}),
        ...(search
          ? { text: { contains: search, mode: "insensitive" as const } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: messageInclude,
    });
    const rows = search ? rowsRaw : rowsRaw.slice().reverse();

    const convMeta = await prisma.conversation.findUnique({
      where: { id },
      include: { members: { select: { userId: true } } },
    });
    const peerId = convMeta?.members.find((m) => m.userId !== userId)?.userId;
    const blocked =
      convMeta?.type === "DIRECT" && peerId
        ? await isBlockedEitherWay(userId, peerId)
        : false;

    // Blocked chats never advance ticks (WhatsApp single-tick behavior).
    if (!blocked) {
      const toDeliver = await prisma.message.findMany({
        where: {
          conversationId: id,
          senderId: { not: userId },
          status: "SENT",
          deletedForEveryoneAt: null,
        },
        select: { id: true },
      });
      if (toDeliver.length > 0) {
        await prisma.message.updateMany({
          where: { id: { in: toDeliver.map((m) => m.id) } },
          data: { status: "DELIVERED" },
        });
        void emitReceipt(
          id,
          "delivered",
          toDeliver.map((m) => m.id),
        );
      }
    }

    return { items: rows.map((m) => toMessageDto(m, userId)) };
  });

  app.post("/api/conversations/:id/messages", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const attachmentSchema = z
      .object({
        key: z.string().min(1).max(200),
        url: z.string().url().max(2000),
        mime: z.string().min(3).max(100).optional(),
        size: z.number().int().nonnegative().optional(),
        name: z.string().max(200).optional(),
        width: z.number().int().nonnegative().optional(),
        height: z.number().int().nonnegative().optional(),
        duration: z.number().int().nonnegative().optional(),
        thumbnail_url: z.string().url().max(2000).optional(),
        thumbnail_key: z.string().max(200).optional(),
      })
      .optional();

    const parsed = z
      .object({
        text: z.string().trim().max(4000).optional(),
        client_id: z.string().min(1).max(80).optional(),
        attachment: attachmentSchema,
        reply_to: z
          .object({ id: z.string().min(1) })
          .optional()
          .nullable(),
        contact: z
          .object({
            name: z.string().trim().min(1).max(80),
            phones: z.array(z.string().min(1).max(40)).default([]),
            user_id: z.string().min(1).optional().nullable(),
          })
          .optional(),
        location: z
          .object({
            lat: z.number().min(-90).max(90),
            lng: z.number().min(-180).max(180),
            address: z.string().trim().max(200).optional().nullable(),
            name: z.string().trim().max(120).optional().nullable(),
          })
          .optional(),
        poll: z
          .object({
            question: z.string().trim().min(1).max(200),
            options: z.array(z.string().trim().min(1).max(80)).min(2).max(12),
            multiple: z.boolean().optional(),
          })
          .optional(),
        event: z
          .object({
            title: z.string().trim().min(1).max(120),
            description: z.string().trim().max(1000).optional().nullable(),
            location: z.string().trim().max(200).optional().nullable(),
            starts_at: z.string().min(1),
            ends_at: z.string().optional().nullable(),
            timezone: z.string().max(64).optional().nullable(),
            with_call: z.boolean().optional(),
          })
          .optional(),
      })
      .refine(
        (b) =>
          (b.text && b.text.length > 0) ||
          b.attachment ||
          b.contact ||
          b.location ||
          b.poll ||
          b.event,
        { message: "message_required" },
      )
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    const conv = await prisma.conversation.findUnique({
      where: { id },
      include: { members: { select: { userId: true, role: true } } },
    });
    if (conv?.type === "GROUP" && conv.onlyAdminsCanSend && member.role !== "ADMIN") {
      return reply.code(403).send({ error: "admins_only" });
    }
    if (conv?.type === "DIRECT") {
      const peerId = conv.members.find((m) => m.userId !== userId)?.userId;
      if (peerId && (await isBlockedEitherWay(userId, peerId))) {
        return reply.code(403).send({ error: "blocked" });
      }
    }

    if (parsed.data.client_id) {
      const existing = await prisma.message.findUnique({
        where: {
          conversationId_clientId: {
            conversationId: id,
            clientId: parsed.data.client_id,
          },
        },
        include: messageInclude,
      });
      if (existing) {
        return toMessageDto(existing, userId);
      }
    }

    let replyToId: string | undefined;
    if (parsed.data.reply_to?.id) {
      const parent = await prisma.message.findFirst({
        where: { id: parsed.data.reply_to.id, conversationId: id },
      });
      if (!parent) {
        return reply.code(400).send({ error: "invalid_reply_to" });
      }
      replyToId = parent.id;
    }

    const att = parsed.data.attachment;
    let msgType: MessageType = att ? messageTypeFromMime(att.mime) : "TEXT";
    let payload: Prisma.InputJsonValue | undefined;
    let text = parsed.data.text?.trim() || null;

    if (parsed.data.contact) {
      msgType = "CONTACT";
      payload = buildContactPayload(parsed.data.contact);
      text = previewForRichType("CONTACT", payload);
    } else if (parsed.data.location) {
      msgType = "LOCATION";
      payload = buildLocationPayload(parsed.data.location);
      text = previewForRichType("LOCATION", payload);
    } else if (parsed.data.poll) {
      msgType = "POLL";
      payload = buildPollPayload(parsed.data.poll);
      text = previewForRichType("POLL", payload);
    } else if (parsed.data.event) {
      msgType = "EVENT";
      payload = buildEventPayload(parsed.data.event);
      text = previewForRichType("EVENT", payload);
    } else if (att) {
      text = text || previewForType(msgType, att.name);
    }

    let preview: Prisma.InputJsonValue | undefined;
    if (msgType === "TEXT" && text) {
      const url = firstUrlInText(text);
      if (url) {
        const card = await unfurlUrl(url);
        if (card) preview = card;
      }
    }

    const ttl = conv?.disappearingSeconds ?? 0;
    const expiresAt =
      ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined;

    const created = await prisma.message.create({
      data: {
        conversationId: id,
        senderId: userId,
        type: msgType,
        text,
        attachment: att ?? undefined,
        payload,
        preview,
        clientId: parsed.data.client_id,
        status: "SENT",
        replyToId,
        expiresAt,
      },
    });

    await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    // If any peer is connected, mark delivered immediately.
    const peers = await prisma.conversationMember.findMany({
      where: { conversationId: id, userId: { not: userId } },
      select: { userId: true },
    });
    const anyPeerOnline = peers.some((p) => realtimeHub.isOnline(p.userId));
    if (anyPeerOnline) {
      await prisma.message.update({
        where: { id: created.id },
        data: { status: "DELIVERED" },
      });
    }

    const dto = await loadMessageDto(created.id, userId);
    if (!dto) {
      return reply.code(500).send({ error: "create_failed" });
    }
    // Sender is in room when composing — notify room + offline peers.
    realtimeHub.toRoom(id, { type: "message", data: dto });
    for (const peer of peers) {
      if (!realtimeHub.isInRoom(peer.userId, id)) {
        realtimeHub.toUser(peer.userId, { type: "message", data: dto });
      }
    }

    if (anyPeerOnline) {
      void emitReceipt(id, "delivered", [created.id]);
    }

    const pushPreview =
      created.type === "TEXT" || created.type === "IMAGE" || created.type === "AUDIO" ||
      created.type === "FILE" || created.type === "VIDEO"
        ? previewForType(created.type, att?.name)
        : (created.text ?? previewForRichType(created.type, payload));
    void notifyNewMessage({
      conversationId: id,
      senderId: userId,
      preview: created.type === "TEXT" ? (created.text ?? pushPreview) : pushPreview,
      messageId: created.id,
    }).catch((err) => {
      req.log.warn({ err }, "push notify failed");
    });

    return reply.code(201).send(dto);
  });

  /** Shared media gallery for a conversation (images / videos / docs / audio). */
  app.get("/api/conversations/:id/media", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const q = req.query as { type?: string; limit?: string };
    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    const typeFilter = (q.type ?? "all").toLowerCase();
    const types =
      typeFilter === "images"
        ? (["IMAGE"] as const)
        : typeFilter === "videos"
          ? (["VIDEO"] as const)
          : typeFilter === "docs" || typeFilter === "documents"
            ? (["FILE"] as const)
            : typeFilter === "audio" || typeFilter === "voice"
              ? (["AUDIO"] as const)
              : (["IMAGE", "VIDEO", "FILE", "AUDIO"] as const);

    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 60) || 60));
    const rows = await prisma.message.findMany({
      where: {
        conversationId: id,
        type: { in: [...types] },
        deletedForEveryoneAt: null,
        attachment: { not: Prisma.DbNull },
        hides: { none: { userId } },
        ...(member.clearedAt ? { createdAt: { gt: member.clearedAt } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: messageInclude,
    });

    return {
      items: rows.map((m) => toMessageDto(m, userId)),
    };
  });

  app.get("/api/conversations/:id/media/counts", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }
    const base = {
      conversationId: id,
      deletedForEveryoneAt: null,
      attachment: { not: Prisma.DbNull },
      hides: { none: { userId } },
      ...(member.clearedAt ? { createdAt: { gt: member.clearedAt } } : {}),
    };
    const [images, videos, docs, audio] = await Promise.all([
      prisma.message.count({ where: { ...base, type: "IMAGE" } }),
      prisma.message.count({ where: { ...base, type: "VIDEO" } }),
      prisma.message.count({ where: { ...base, type: "FILE" } }),
      prisma.message.count({ where: { ...base, type: "AUDIO" } }),
    ]);
    return { images, videos, docs, audio, total: images + videos + docs + audio };
  });

  app.post("/api/conversations/:id/read", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    const convMeta = await prisma.conversation.findUnique({
      where: { id },
      include: { members: { select: { userId: true } } },
    });
    const peerId = convMeta?.members.find((m) => m.userId !== userId)?.userId;
    if (
      convMeta?.type === "DIRECT" &&
      peerId &&
      (await isBlockedEitherWay(userId, peerId))
    ) {
      return { ok: true, updated: 0 };
    }

    const toRead = await prisma.message.findMany({
      where: {
        conversationId: id,
        senderId: { not: userId },
        status: { in: ["SENT", "DELIVERED"] },
        deletedForEveryoneAt: null,
      },
      select: { id: true },
    });
    if (toRead.length > 0) {
      await prisma.message.updateMany({
        where: { id: { in: toRead.map((m) => m.id) } },
        data: { status: "READ" },
      });
      void emitReceipt(
        id,
        "read",
        toRead.map((m) => m.id),
      );
    }

    // 200 + JSON so Android Retrofit (ResponseBody) does not fail on empty 204.
    return { ok: true, updated: toRead.length };
  });

  app.post("/api/messages/delivered", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        message_ids: z.array(z.string().min(1)).min(1).max(100),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const messages = await prisma.message.findMany({
      where: {
        id: { in: parsed.data.message_ids },
        senderId: { not: userId },
        status: "SENT",
        deletedForEveryoneAt: null,
      },
    });
    if (messages.length === 0) {
      return { updated: 0 };
    }

    // Only mark if caller is a member of that conversation.
    const allowed: string[] = [];
    const byConv = new Map<string, string[]>();
    for (const m of messages) {
      const mem = await assertMember(m.conversationId, userId);
      if (!mem) continue;
      allowed.push(m.id);
      const list = byConv.get(m.conversationId) ?? [];
      list.push(m.id);
      byConv.set(m.conversationId, list);
    }
    if (allowed.length === 0) {
      return { updated: 0 };
    }

    await prisma.message.updateMany({
      where: { id: { in: allowed } },
      data: { status: "DELIVERED" },
    });
    for (const [conversationId, ids] of byConv) {
      void emitReceipt(conversationId, "delivered", ids);
    }
    return { updated: allowed.length };
  });

  app.delete("/api/messages/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const q = req.query as { for?: string };
    const scope = (q.for ?? "me").toLowerCase();

    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg) {
      return reply.code(404).send({ error: "not_found" });
    }
    const member = await assertMember(msg.conversationId, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    if (scope === "everyone") {
      if (msg.senderId !== userId) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await prisma.message.update({
        where: { id },
        data: {
          deletedForEveryoneAt: new Date(),
          text: null,
          attachment: Prisma.DbNull,
        },
      });
      const dto = await loadMessageDto(id, userId);
      if (!dto) {
        return reply.code(404).send({ error: "not_found" });
      }
      realtimeHub.toRoom(msg.conversationId, { type: "message_deleted", data: dto });
      realtimeHub.toRoom(msg.conversationId, { type: "message", data: dto });
      return dto;
    }

    await prisma.messageHide.upsert({
      where: { messageId_userId: { messageId: id, userId } },
      create: { messageId: id, userId },
      update: {},
    });
    return { ok: true };
  });

  app.post("/api/conversations/:id/clear", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId } },
      data: { clearedAt: new Date() },
    });

    return { ok: true };
  });

  app.post("/api/messages/:id/reactions", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ emoji: z.string().trim().min(1).max(16) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg || msg.deletedForEveryoneAt) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!(await assertMember(msg.conversationId, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }

    const existing = await prisma.messageReaction.findUnique({
      where: { messageId_userId: { messageId: id, userId } },
    });
    if (existing && existing.emoji === parsed.data.emoji) {
      await prisma.messageReaction.delete({ where: { id: existing.id } });
    } else {
      await prisma.messageReaction.upsert({
        where: { messageId_userId: { messageId: id, userId } },
        create: { messageId: id, userId, emoji: parsed.data.emoji },
        update: { emoji: parsed.data.emoji },
      });
    }

    const dto = await loadMessageDto(id, userId);
    if (!dto) return reply.code(404).send({ error: "not_found" });
    broadcastMessage(msg.conversationId, dto);
    return dto;
  });

  app.post("/api/messages/:id/star", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg) return reply.code(404).send({ error: "not_found" });
    if (!(await assertMember(msg.conversationId, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }

    await prisma.messageStar.upsert({
      where: { messageId_userId: { messageId: id, userId } },
      create: { messageId: id, userId },
      update: {},
    });
    const dto = await loadMessageDto(id, userId);
    return dto ?? reply.code(404).send({ error: "not_found" });
  });

  app.delete("/api/messages/:id/star", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    await prisma.messageStar.deleteMany({ where: { messageId: id, userId } });
    const dto = await loadMessageDto(id, userId);
    return dto ?? { ok: true };
  });

  app.get("/api/me/starred", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const stars = await prisma.messageStar.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        message: { include: messageInclude },
      },
    });
    return {
      items: stars
        .filter((s) => !s.message.deletedForEveryoneAt)
        .map((s) => ({
          ...toMessageDto(s.message, userId),
          conversation_id: s.message.conversationId,
          starred_at: s.createdAt.toISOString(),
        })),
    };
  });

  app.post("/api/messages/:id/forward", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ conversation_id: z.string().min(1) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const source = await prisma.message.findUnique({ where: { id } });
    if (!source || source.deletedForEveryoneAt) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!(await assertMember(source.conversationId, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const targetId = parsed.data.conversation_id;
    if (!(await assertMember(targetId, userId))) {
      return reply.code(404).send({ error: "target_not_found" });
    }

    const created = await prisma.message.create({
      data: {
        conversationId: targetId,
        senderId: userId,
        type: source.type,
        text: source.text,
        attachment: source.attachment ?? undefined,
        payload: source.payload ?? undefined,
        status: "SENT",
        forwarded: true,
      },
    });
    await prisma.conversation.update({
      where: { id: targetId },
      data: { updatedAt: new Date() },
    });

    const dto = await loadMessageDto(created.id, userId);
    if (!dto) return reply.code(500).send({ error: "forward_failed" });
    broadcastMessage(targetId, dto, userId);
    realtimeHub.toRoom(targetId, { type: "message", data: dto });

    const preview =
      created.type === "IMAGE" ? "Photo" : (created.text ?? "Forwarded message");
    void notifyNewMessage({
      conversationId: targetId,
      senderId: userId,
      preview,
      messageId: created.id,
    }).catch(() => {});

    return reply.code(201).send(dto);
  });

  app.post("/api/messages/:id/vote", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        option_id: z.string().min(1).optional(),
        option_ids: z.array(z.string().min(1)).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg || msg.type !== "POLL" || msg.deletedForEveryoneAt) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!(await assertMember(msg.conversationId, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const payload = (msg.payload ?? {}) as {
      question?: string;
      multiple?: boolean;
      closed?: boolean;
      options?: { id: string; text: string; voter_ids: string[] }[];
    };
    if (payload.closed) {
      return reply.code(400).send({ error: "poll_closed" });
    }
    const optionIds = new Set(
      parsed.data.option_ids?.length
        ? parsed.data.option_ids
        : parsed.data.option_id
          ? [parsed.data.option_id]
          : [],
    );
    if (optionIds.size === 0) {
      return reply.code(400).send({ error: "option_required" });
    }
    if (!payload.multiple && optionIds.size > 1) {
      return reply.code(400).send({ error: "single_choice" });
    }
    const options = (payload.options ?? []).map((o) => {
      const voters = new Set(o.voter_ids ?? []);
      voters.delete(userId);
      if (optionIds.has(o.id)) voters.add(userId);
      return { ...o, voter_ids: [...voters] };
    });
    if (![...optionIds].every((oid) => options.some((o) => o.id === oid))) {
      return reply.code(400).send({ error: "invalid_option" });
    }
    const updated = await prisma.message.update({
      where: { id },
      data: { payload: { ...payload, options } },
      include: messageInclude,
    });
    const dto = toMessageDto(updated, userId);
    broadcastMessage(msg.conversationId, dto);
    return dto;
  });

  app.post("/api/messages/:id/rsvp", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        answer: z.enum(["going", "maybe", "not_going"]),
        plus_one: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg || msg.type !== "EVENT" || msg.deletedForEveryoneAt) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!(await assertMember(msg.conversationId, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const payload = (msg.payload ?? {}) as {
      title?: string;
      rsvps?: { user_id: string; answer: string; plus_one?: boolean }[];
      [k: string]: unknown;
    };
    if (payload.cancelled) {
      return reply.code(400).send({ error: "event_cancelled" });
    }
    const rsvps = (payload.rsvps ?? []).filter((r) => r.user_id !== userId);
    rsvps.push({
      user_id: userId,
      answer: parsed.data.answer,
      plus_one: Boolean(parsed.data.plus_one),
    });
    const updated = await prisma.message.update({
      where: { id },
      data: { payload: { ...payload, rsvps } },
      include: messageInclude,
    });
    const dto = toMessageDto(updated, userId);
    broadcastMessage(msg.conversationId, dto);
    return dto;
  });
}
