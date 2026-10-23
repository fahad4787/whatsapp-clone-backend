import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { isBlockedEitherWay } from "../blocks.js";
import { messageInclude, toMessageDto } from "../messages.js";
import { requireUser } from "../plugins/auth.js";
import { realtimeHub } from "../realtime/hub.js";
import { notifyNewMessage } from "../push/fcm.js";

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

    const rows = await prisma.message.findMany({
      where: {
        conversationId: id,
        hides: { none: { userId } },
        deletedForEveryoneAt: search ? null : undefined,
        ...(member.clearedAt ? { createdAt: { gt: member.clearedAt } } : {}),
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
        ...(search
          ? { text: { contains: search, mode: "insensitive" as const } }
          : {}),
      },
      orderBy: { createdAt: search ? "desc" : "asc" },
      take: limit,
      include: messageInclude,
    });

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
      })
      .refine((b) => (b.text && b.text.length > 0) || b.attachment, {
        message: "text_or_attachment_required",
      })
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
      include: { members: { select: { userId: true } } },
    });
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

    const isImage = Boolean(parsed.data.attachment);
    const created = await prisma.message.create({
      data: {
        conversationId: id,
        senderId: userId,
        type: isImage ? "IMAGE" : "TEXT",
        text: parsed.data.text?.trim() || (isImage ? "Photo" : null),
        attachment: parsed.data.attachment ?? undefined,
        clientId: parsed.data.client_id,
        status: "SENT",
        replyToId,
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

    const preview =
      created.type === "IMAGE" ? "Photo" : (created.text ?? "New message");
    void notifyNewMessage({
      conversationId: id,
      senderId: userId,
      preview,
      messageId: created.id,
    }).catch((err) => {
      req.log.warn({ err }, "push notify failed");
    });

    return reply.code(201).send(dto);
  });

  app.post("/api/conversations/:id/read", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
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
}
