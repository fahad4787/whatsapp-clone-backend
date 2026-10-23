import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { toMessageDto } from "../messages.js";
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
    const q = req.query as { limit?: string; before?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));

    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    const rows = await prisma.message.findMany({
      where: {
        conversationId: id,
        hides: { none: { userId } },
        ...(member.clearedAt ? { createdAt: { gt: member.clearedAt } } : {}),
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: limit,
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

    return { items: rows.map(toMessageDto) };
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

    if (parsed.data.client_id) {
      const existing = await prisma.message.findUnique({
        where: {
          conversationId_clientId: {
            conversationId: id,
            clientId: parsed.data.client_id,
          },
        },
      });
      if (existing) {
        return toMessageDto(existing);
      }
    }

    const isImage = Boolean(parsed.data.attachment);
    let msg = await prisma.message.create({
      data: {
        conversationId: id,
        senderId: userId,
        type: isImage ? "IMAGE" : "TEXT",
        text: parsed.data.text?.trim() || (isImage ? "Photo" : null),
        attachment: parsed.data.attachment ?? undefined,
        clientId: parsed.data.client_id,
        status: "SENT",
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
      msg = await prisma.message.update({
        where: { id: msg.id },
        data: { status: "DELIVERED" },
      });
    }

    const dto = toMessageDto(msg);
    realtimeHub.toRoom(id, { type: "message", data: dto });

    for (const peer of peers) {
      if (!realtimeHub.isInRoom(peer.userId, id)) {
        realtimeHub.toUser(peer.userId, { type: "message", data: dto });
      }
    }

    if (anyPeerOnline) {
      void emitReceipt(id, "delivered", [msg.id]);
    }

    const preview =
      msg.type === "IMAGE" ? "Photo" : (msg.text ?? "New message");
    void notifyNewMessage({
      conversationId: id,
      senderId: userId,
      preview,
      messageId: msg.id,
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

    return reply.code(204).send();
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
      const updated = await prisma.message.update({
        where: { id },
        data: {
          deletedForEveryoneAt: new Date(),
          text: null,
          attachment: Prisma.DbNull,
        },
      });
      const dto = toMessageDto(updated);
      realtimeHub.toRoom(msg.conversationId, { type: "message_deleted", data: dto });
      // Also push as message update for clients that only listen for message.
      realtimeHub.toRoom(msg.conversationId, { type: "message", data: dto });
      return dto;
    }

    await prisma.messageHide.upsert({
      where: { messageId_userId: { messageId: id, userId } },
      create: { messageId: id, userId },
      update: {},
    });
    return reply.code(204).send();
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

    return reply.code(204).send();
  });
}
