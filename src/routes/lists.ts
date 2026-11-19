import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";

function listDto(list: {
  id: string;
  name: string;
  sortOrder: number;
  members: { conversationId: string }[];
}) {
  return {
    id: list.id,
    name: list.name,
    sort_order: list.sortOrder,
    conversation_ids: list.members.map((m) => m.conversationId),
  };
}

export async function listRoutes(app: FastifyInstance) {
  app.get("/api/me/lists", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const lists = await prisma.chatList.findMany({
      where: { userId },
      include: { members: { select: { conversationId: true } } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return { items: lists.map(listDto) };
  });

  app.post("/api/me/lists", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40),
        conversation_ids: z.array(z.string().min(1)).max(500).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const ids = [...new Set(parsed.data.conversation_ids ?? [])];
    if (ids.length > 0) {
      const memberships = await prisma.conversationMember.count({
        where: { userId, conversationId: { in: ids } },
      });
      if (memberships !== ids.length) {
        return reply.code(400).send({ error: "invalid_conversations" });
      }
    }

    const maxOrder = await prisma.chatList.aggregate({
      where: { userId },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1;

    const created = await prisma.chatList.create({
      data: {
        userId,
        name: parsed.data.name,
        sortOrder,
        members: ids.length
          ? { create: ids.map((conversationId) => ({ conversationId })) }
          : undefined,
      },
      include: { members: { select: { conversationId: true } } },
    });
    return reply.code(201).send(listDto(created));
  });

  app.patch("/api/me/lists/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        conversation_ids: z.array(z.string().min(1)).max(500).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    if (parsed.data.name === undefined && parsed.data.conversation_ids === undefined) {
      return reply.code(400).send({ error: "empty_patch" });
    }

    const existing = await prisma.chatList.findFirst({ where: { id, userId } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    if (parsed.data.conversation_ids !== undefined) {
      const ids = [...new Set(parsed.data.conversation_ids)];
      if (ids.length > 0) {
        const memberships = await prisma.conversationMember.count({
          where: { userId, conversationId: { in: ids } },
        });
        if (memberships !== ids.length) {
          return reply.code(400).send({ error: "invalid_conversations" });
        }
      }
      await prisma.chatListMember.deleteMany({ where: { listId: id } });
      if (ids.length) {
        await prisma.chatListMember.createMany({
          data: ids.map((conversationId) => ({ listId: id, conversationId })),
          skipDuplicates: true,
        });
      }
    }

    const updated = await prisma.chatList.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      },
      include: { members: { select: { conversationId: true } } },
    });
    return listDto(updated);
  });

  app.delete("/api/me/lists/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const existing = await prisma.chatList.findFirst({ where: { id, userId } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await prisma.chatList.delete({ where: { id } });
    return { ok: true };
  });

  app.put("/api/me/lists/order", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({ ids: z.array(z.string().min(1)).max(100) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const owned = await prisma.chatList.findMany({
      where: { userId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((l) => l.id));
    if (parsed.data.ids.some((id) => !ownedIds.has(id))) {
      return reply.code(400).send({ error: "invalid_ids" });
    }

    await prisma.$transaction(
      parsed.data.ids.map((id, index) =>
        prisma.chatList.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );

    const lists = await prisma.chatList.findMany({
      where: { userId },
      include: { members: { select: { conversationId: true } } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return { items: lists.map(listDto) };
  });
}
