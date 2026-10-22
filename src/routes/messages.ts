import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { toMessageDto } from "../messages.js";
import { requireUser } from "../plugins/auth.js";
import { realtimeHub } from "../realtime/hub.js";

async function assertMember(conversationId: string, userId: string) {
  return prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: { conversationId, userId },
    },
  });
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
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    // Mark peer messages as delivered when listed
    const delivered = await prisma.message.updateMany({
      where: {
        conversationId: id,
        senderId: { not: userId },
        status: "SENT",
      },
      data: { status: "DELIVERED" },
    });
    if (delivered.count > 0) {
      realtimeHub.toRoom(id, {
        type: "receipt",
        data: {
          conversation_id: id,
          message_id: null,
          status: "delivered",
        },
      });
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
    const msg = await prisma.message.create({
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

    const dto = toMessageDto(msg);
    realtimeHub.toRoom(id, { type: "message", data: dto });

    return reply.code(201).send(dto);
  });

  app.post("/api/conversations/:id/read", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    const updated = await prisma.message.updateMany({
      where: {
        conversationId: id,
        senderId: { not: userId },
        status: { in: ["SENT", "DELIVERED"] },
      },
      data: { status: "READ" },
    });
    if (updated.count > 0) {
      realtimeHub.toRoom(id, {
        type: "receipt",
        data: {
          conversation_id: id,
          message_id: null,
          status: "read",
        },
      });
    }

    return reply.code(204).send();
  });
}
