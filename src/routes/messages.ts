import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { toMessageDto } from "../messages.js";
import { requireUser } from "../plugins/auth.js";

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
    await prisma.message.updateMany({
      where: {
        conversationId: id,
        senderId: { not: userId },
        status: "SENT",
      },
      data: { status: "DELIVERED" },
    });

    return { items: rows.map(toMessageDto) };
  });

  app.post("/api/conversations/:id/messages", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        text: z.string().trim().min(1).max(4000),
        client_id: z.string().min(1).max(80).optional(),
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

    const msg = await prisma.message.create({
      data: {
        conversationId: id,
        senderId: userId,
        type: "TEXT",
        text: parsed.data.text,
        clientId: parsed.data.client_id,
        status: "SENT",
      },
    });

    await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    return reply.code(201).send(toMessageDto(msg));
  });

  app.post("/api/conversations/:id/read", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const member = await assertMember(id, userId);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    await prisma.message.updateMany({
      where: {
        conversationId: id,
        senderId: { not: userId },
        status: { in: ["SENT", "DELIVERED"] },
      },
      data: { status: "READ" },
    });

    return reply.code(204).send();
  });
}
