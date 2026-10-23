import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { directKeyFor, toConversationDto } from "../conversations.js";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";

const memberInclude = {
  members: { include: { user: true } },
  messages: { orderBy: { createdAt: "desc" as const }, take: 1 },
} as const;

async function loadConversation(id: string) {
  return prisma.conversation.findUnique({
    where: { id },
    include: memberInclude,
  });
}

export async function conversationRoutes(app: FastifyInstance) {
  app.get("/api/conversations", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const memberships = await prisma.conversationMember.findMany({
      where: { userId },
      include: {
        conversation: { include: memberInclude },
      },
      orderBy: { conversation: { updatedAt: "desc" } },
    });

    const items = await Promise.all(
      memberships.map(async (m) => {
        const unread = await prisma.message.count({
          where: {
            conversationId: m.conversationId,
            senderId: { not: userId },
            status: { not: "READ" },
            deletedForEveryoneAt: null,
            hides: { none: { userId } },
            ...(m.clearedAt ? { createdAt: { gt: m.clearedAt } } : {}),
          },
        });
        return toConversationDto(m.conversation, userId, unread);
      }),
    );
    return { items };
  });

  app.get("/api/conversations/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const conv = await loadConversation(id);
    if (!conv || !conv.members.some((m) => m.userId === userId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const membership = conv.members.find((m) => m.userId === userId);
    const unread = await prisma.message.count({
      where: {
        conversationId: id,
        senderId: { not: userId },
        status: { not: "READ" },
        deletedForEveryoneAt: null,
        hides: { none: { userId } },
        ...(membership?.clearedAt ? { createdAt: { gt: membership.clearedAt } } : {}),
      },
    });
    return toConversationDto(conv, userId, unread);
  });

  app.post("/api/conversations/direct", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z.object({ user_id: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const peerId = parsed.data.user_id;
    if (peerId === userId) {
      return reply.code(400).send({ error: "cannot_chat_self" });
    }

    const peer = await prisma.user.findUnique({ where: { id: peerId } });
    if (!peer || peer.bannedAt) {
      return reply.code(404).send({ error: "user_not_found" });
    }

    const key = directKeyFor(userId, peerId);
    const existing = await prisma.conversation.findUnique({
      where: { directKey: key },
      include: memberInclude,
    });
    if (existing) {
      return toConversationDto(existing, userId);
    }

    const created = await prisma.conversation.create({
      data: {
        type: "DIRECT",
        directKey: key,
        members: {
          create: [
            { userId, role: "MEMBER" },
            { userId: peerId, role: "MEMBER" },
          ],
        },
      },
      include: memberInclude,
    });
    return reply.code(201).send(toConversationDto(created, userId));
  });

  app.post("/api/conversations/group", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(80),
        member_ids: z.array(z.string().min(1)).default([]),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const memberIds = [...new Set(parsed.data.member_ids.filter((id) => id !== userId))];
    if (memberIds.length === 0) {
      return reply.code(400).send({ error: "members_required" });
    }

    const users = await prisma.user.findMany({
      where: { id: { in: memberIds }, bannedAt: null },
    });
    if (users.length !== memberIds.length) {
      return reply.code(400).send({ error: "invalid_members" });
    }

    const created = await prisma.conversation.create({
      data: {
        type: "GROUP",
        title: parsed.data.title,
        members: {
          create: [
            { userId, role: "ADMIN" },
            ...memberIds.map((id) => ({ userId: id, role: "MEMBER" as const })),
          ],
        },
      },
      include: memberInclude,
    });
    return reply.code(201).send(toConversationDto(created, userId));
  });

  app.post("/api/conversations/:id/members", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z.object({ user_ids: z.array(z.string().min(1)).min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const conv = await loadConversation(id);
    if (!conv) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (conv.type !== "GROUP") {
      return reply.code(400).send({ error: "not_a_group" });
    }
    const me = conv.members.find((m) => m.userId === userId);
    if (!me || me.role !== "ADMIN") {
      return reply.code(403).send({ error: "forbidden" });
    }

    const existingIds = new Set(conv.members.map((m) => m.userId));
    const toAdd = [...new Set(parsed.data.user_ids)].filter((id) => !existingIds.has(id));
    if (toAdd.length === 0) {
      return toConversationDto(conv, userId);
    }

    const users = await prisma.user.findMany({
      where: { id: { in: toAdd }, bannedAt: null },
    });
    if (users.length !== toAdd.length) {
      return reply.code(400).send({ error: "invalid_members" });
    }

    await prisma.conversationMember.createMany({
      data: toAdd.map((uid) => ({
        conversationId: id,
        userId: uid,
        role: "MEMBER",
      })),
    });
    await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    const updated = await loadConversation(id);
    return toConversationDto(updated!, userId);
  });
}
