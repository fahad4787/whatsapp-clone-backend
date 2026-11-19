import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";

async function ensureSeedCommunity(userId: string) {
  const count = await prisma.community.count();
  if (count > 0) return;
  const community = await prisma.community.create({
    data: {
      name: "Local Neighbors",
      description: "Neighborhood groups and announcements.",
      members: {
        create: { userId, role: "admin" },
      },
    },
  });
  // Link any existing group the user is in (optional shell).
  const membership = await prisma.conversationMember.findFirst({
    where: { userId, conversation: { type: "GROUP" } },
    include: { conversation: true },
  });
  if (membership) {
    await prisma.communityGroupLink.create({
      data: {
        communityId: community.id,
        conversationId: membership.conversationId,
        title: membership.conversation.title ?? "General",
      },
    });
  }
}

async function toCommunityDto(id: string, userId: string) {
  const c = await prisma.community.findUnique({
    where: { id },
    include: {
      members: true,
      groups: true,
      _count: { select: { members: true, groups: true } },
    },
  });
  if (!c) return null;
  const me = c.members.find((m) => m.userId === userId);
  const groupIds = c.groups.map((g) => g.conversationId);
  const joined = groupIds.length
    ? await prisma.conversationMember.findMany({
        where: { userId, conversationId: { in: groupIds } },
        select: { conversationId: true },
      })
    : [];
  const joinedSet = new Set(joined.map((j) => j.conversationId));
  const memberCounts = groupIds.length
    ? await prisma.conversationMember.groupBy({
        by: ["conversationId"],
        where: { conversationId: { in: groupIds } },
        _count: { _all: true },
      })
    : [];
  const countMap = new Map(memberCounts.map((m) => [m.conversationId, m._count._all]));

  return {
    id: c.id,
    name: c.name,
    description: c.description,
    avatar_url: c.avatarUrl,
    announcement_id: c.announcementConversationId,
    member_count: c._count.members,
    group_count: c._count.groups,
    role: me?.role ?? null,
    is_admin: me?.role === "admin",
    groups: c.groups.map((g) => ({
      id: g.conversationId,
      title: g.title ?? "Group",
      avatar_url: null,
      member_count: countMap.get(g.conversationId) ?? 0,
      visible: true,
      joined: joinedSet.has(g.conversationId),
    })),
  };
}

export async function communityRoutes(app: FastifyInstance) {
  app.get("/api/communities", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    await ensureSeedCommunity(userId);
    const mine = await prisma.communityMember.findMany({
      where: { userId },
      select: { communityId: true },
    });
    const ids = mine.map((m) => m.communityId);
    const all = await prisma.community.findMany({
      where: ids.length ? { id: { in: ids } } : undefined,
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    // If user has no memberships yet, show seed communities after ensure.
    const list =
      all.length > 0
        ? all
        : await prisma.community.findMany({ orderBy: { updatedAt: "desc" }, take: 20 });
    const items = [];
    for (const c of list) {
      const dto = await toCommunityDto(c.id, userId);
      if (dto) items.push(dto);
    }
    return { items };
  });

  app.post("/api/communities", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(80),
        description: z.string().trim().max(500).optional().nullable(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const c = await prisma.community.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        members: { create: { userId, role: "admin" } },
      },
    });
    return reply.code(201).send(await toCommunityDto(c.id, userId));
  });

  app.get("/api/communities/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    await ensureSeedCommunity(userId);
    const dto = await toCommunityDto(id, userId);
    if (!dto) return reply.code(404).send({ error: "not_found" });
    return dto;
  });

  app.post(
    "/api/communities/:id/groups/:conversationId/join",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = (req as typeof req & { userId: string }).userId;
      const { id, conversationId } = req.params as {
        id: string;
        conversationId: string;
      };
      const link = await prisma.communityGroupLink.findFirst({
        where: { communityId: id, conversationId },
      });
      if (!link) return reply.code(404).send({ error: "not_found" });
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!conv || conv.type !== "GROUP") {
        return reply.code(404).send({ error: "not_found" });
      }
      await prisma.communityMember.upsert({
        where: { communityId_userId: { communityId: id, userId } },
        create: { communityId: id, userId, role: "member" },
        update: {},
      });
      await prisma.conversationMember.upsert({
        where: {
          conversationId_userId: { conversationId, userId },
        },
        create: { conversationId, userId, role: "MEMBER" },
        update: {},
      });
      return toCommunityDto(id, userId);
    },
  );
}
