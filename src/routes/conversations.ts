import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isBlockedEitherWay } from "../blocks.js";
import { directKeyFor, toConversationDtoAsync } from "../conversations.js";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";
import { publicUrl } from "../publicUrl.js";
import { extFromMime } from "../mediaTypes.js";

const GROUP_AVATAR_DIR = path.join(process.cwd(), "uploads", "group-avatars");

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

const PIN_MAX = 3;

export async function conversationRoutes(app: FastifyInstance) {
  app.get("/api/conversations", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const memberships = await prisma.conversationMember.findMany({
      where: { userId },
      include: {
        conversation: { include: memberInclude },
      },
      orderBy: [
        { pinnedAt: "desc" },
        { conversation: { updatedAt: "desc" } },
      ],
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
        return toConversationDtoAsync(m.conversation, userId, unread);
      }),
    );
    // Pinned first (nulls last), then recency — mirrors WhatsApp home.
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const ta = a.updated_at ?? "";
      const tb = b.updated_at ?? "";
      return tb.localeCompare(ta);
    });
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
    return toConversationDtoAsync(conv, userId, unread);
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
    if (await isBlockedEitherWay(userId, peerId)) {
      return reply.code(403).send({ error: "blocked" });
    }

    const key = directKeyFor(userId, peerId);
    const existing = await prisma.conversation.findUnique({
      where: { directKey: key },
      include: memberInclude,
    });
    if (existing) {
      return toConversationDtoAsync(existing, userId);
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
    return reply.code(201).send(await toConversationDtoAsync(created, userId));
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
    return reply.code(201).send(await toConversationDtoAsync(created, userId));
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
      return toConversationDtoAsync(conv, userId);
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
    return toConversationDtoAsync(updated!, userId);
  });

  app.put("/api/conversations/:id/settings", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        archived: z.boolean().optional(),
        pinned: z.boolean().optional(),
        muted: z.boolean().optional(),
        muted_until: z.string().datetime().nullable().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (
      parsed.data.archived === undefined &&
      parsed.data.pinned === undefined &&
      parsed.data.muted === undefined &&
      parsed.data.muted_until === undefined
    ) {
      return reply.code(400).send({ error: "empty_settings" });
    }

    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: id, userId } },
    });
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }

    const data: {
      archived?: boolean;
      pinnedAt?: Date | null;
      mutedUntil?: Date | null;
    } = {};

    if (parsed.data.archived !== undefined) {
      data.archived = parsed.data.archived;
    }
    if (parsed.data.muted_until !== undefined) {
      data.mutedUntil = parsed.data.muted_until ? new Date(parsed.data.muted_until) : null;
    } else if (parsed.data.muted === true) {
      data.mutedUntil = new Date(Date.now() + 8 * 3600_000);
    } else if (parsed.data.muted === false) {
      data.mutedUntil = null;
    }
    if (parsed.data.pinned !== undefined) {
      if (parsed.data.pinned) {
        const pinnedCount = await prisma.conversationMember.count({
          where: { userId, pinnedAt: { not: null }, NOT: { conversationId: id } },
        });
        if (pinnedCount >= PIN_MAX) {
          return reply.code(400).send({ error: "pin_limit", max: PIN_MAX });
        }
        data.pinnedAt = new Date();
      } else {
        data.pinnedAt = null;
      }
    }

    const updated = await prisma.conversationMember.update({
      where: { id: member.id },
      data,
    });

    // Slim payload — avoids Android kotlinx decode issues on full conversation graphs.
    return {
      id,
      archived: updated.archived,
      pinned: Boolean(updated.pinnedAt),
      muted_until: updated.mutedUntil?.toISOString() ?? null,
    };
  });

  // --- Wave 13: group admin ---

  async function requireGroupAdmin(id: string, userId: string) {
    const conv = await loadConversation(id);
    if (!conv) return { error: "not_found" as const, code: 404 as const };
    if (conv.type !== "GROUP") return { error: "not_a_group" as const, code: 400 as const };
    const me = conv.members.find((m) => m.userId === userId);
    if (!me) return { error: "not_found" as const, code: 404 as const };
    if (me.role !== "ADMIN") return { error: "forbidden" as const, code: 403 as const };
    return { conv, me };
  }

  function canEditGroupInfo(
    conv: Awaited<ReturnType<typeof loadConversation>>,
    me: { role: string },
  ) {
    if (!conv) return false;
    if (me.role === "ADMIN") return true;
    return !conv.onlyAdminsCanEditInfo;
  }

  app.delete("/api/conversations/:id/members/:userId", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id, userId: targetId } = req.params as { id: string; userId: string };
    const gate = await requireGroupAdmin(id, userId);
    if ("error" in gate && gate.error) {
      return reply.code(gate.code).send({ error: gate.error });
    }
    const { conv } = gate;
    if (targetId === userId) {
      return reply.code(400).send({ error: "use_leave" });
    }
    const target = conv.members.find((m) => m.userId === targetId);
    if (!target) {
      return reply.code(404).send({ error: "member_not_found" });
    }
    if (target.role === "ADMIN") {
      const adminCount = conv.members.filter((m) => m.role === "ADMIN").length;
      if (adminCount <= 1) {
        return reply.code(400).send({ error: "last_admin" });
      }
    }
    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: id, userId: targetId } },
    });
    await prisma.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
    const updated = await loadConversation(id);
    return toConversationDtoAsync(updated!, userId);
  });

  app.put("/api/conversations/:id/members/:userId", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id, userId: targetId } = req.params as { id: string; userId: string };
    const parsed = z
      .object({ role: z.enum(["admin", "member"]) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const gate = await requireGroupAdmin(id, userId);
    if ("error" in gate && gate.error) {
      return reply.code(gate.code).send({ error: gate.error });
    }
    const { conv } = gate;
    const target = conv.members.find((m) => m.userId === targetId);
    if (!target) {
      return reply.code(404).send({ error: "member_not_found" });
    }
    const nextRole = parsed.data.role === "admin" ? "ADMIN" : "MEMBER";
    if (target.role === "ADMIN" && nextRole === "MEMBER") {
      const adminCount = conv.members.filter((m) => m.role === "ADMIN").length;
      if (adminCount <= 1) {
        return reply.code(400).send({ error: "last_admin" });
      }
    }
    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId: targetId } },
      data: { role: nextRole },
    });
    const updated = await loadConversation(id);
    return toConversationDtoAsync(updated!, userId);
  });

  app.put("/api/conversations/:id/info", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(500).nullable().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (parsed.data.title === undefined && parsed.data.description === undefined) {
      return reply.code(400).send({ error: "empty_info" });
    }
    const conv = await loadConversation(id);
    if (!conv || conv.type !== "GROUP") {
      return reply.code(conv ? 400 : 404).send({ error: conv ? "not_a_group" : "not_found" });
    }
    const me = conv.members.find((m) => m.userId === userId);
    if (!me) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!canEditGroupInfo(conv, me)) {
      return reply.code(403).send({ error: "admins_only" });
    }
    const data: { title?: string; description?: string | null } = {};
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.description !== undefined) data.description = parsed.data.description;
    await prisma.conversation.update({ where: { id }, data });
    const updated = await loadConversation(id);
    return toConversationDtoAsync(updated!, userId);
  });

  app.post("/api/conversations/:id/avatar", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const conv = await loadConversation(id);
    if (!conv || conv.type !== "GROUP") {
      return reply.code(conv ? 400 : 404).send({ error: conv ? "not_a_group" : "not_found" });
    }
    const me = conv.members.find((m) => m.userId === userId);
    if (!me) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!canEditGroupInfo(conv, me)) {
      return reply.code(403).send({ error: "admins_only" });
    }
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "file_required" });
    }
    if (!file.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "invalid_mime" });
    }
    await mkdir(GROUP_AVATAR_DIR, { recursive: true });
    const filename = `${id}-${Date.now()}.${extFromMime(file.mimetype)}`;
    const diskPath = path.join(GROUP_AVATAR_DIR, filename);
    try {
      await pipeline(file.file, createWriteStream(diskPath));
    } catch {
      await unlink(diskPath).catch(() => undefined);
      return reply.code(413).send({ error: "file_too_large" });
    }
    if (file.file.truncated) {
      await unlink(diskPath).catch(() => undefined);
      return reply.code(413).send({ error: "file_too_large" });
    }
    const avatarUrl = publicUrl(`/uploads/group-avatars/${filename}`);
    if (conv.avatarUrl?.includes("/uploads/group-avatars/")) {
      const oldName = conv.avatarUrl.split("/uploads/group-avatars/").pop();
      if (oldName) {
        await unlink(path.join(GROUP_AVATAR_DIR, oldName)).catch(() => undefined);
      }
    }
    await prisma.conversation.update({ where: { id }, data: { avatarUrl } });
    const updated = await loadConversation(id);
    return toConversationDtoAsync(updated!, userId);
  });

  app.put("/api/conversations/:id/privacy", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        only_admins_can_send: z.boolean().optional(),
        only_admins_can_edit_info: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (
      parsed.data.only_admins_can_send === undefined &&
      parsed.data.only_admins_can_edit_info === undefined
    ) {
      return reply.code(400).send({ error: "empty_privacy" });
    }
    const gate = await requireGroupAdmin(id, userId);
    if ("error" in gate && gate.error) {
      return reply.code(gate.code).send({ error: gate.error });
    }
    await prisma.conversation.update({
      where: { id },
      data: {
        ...(parsed.data.only_admins_can_send !== undefined
          ? { onlyAdminsCanSend: parsed.data.only_admins_can_send }
          : {}),
        ...(parsed.data.only_admins_can_edit_info !== undefined
          ? { onlyAdminsCanEditInfo: parsed.data.only_admins_can_edit_info }
          : {}),
      },
    });
    const updated = await loadConversation(id);
    return toConversationDtoAsync(updated!, userId);
  });

  app.post("/api/conversations/:id/leave", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const conv = await loadConversation(id);
    if (!conv || conv.type !== "GROUP") {
      return reply.code(conv ? 400 : 404).send({ error: conv ? "not_a_group" : "not_found" });
    }
    const me = conv.members.find((m) => m.userId === userId);
    if (!me) {
      return reply.code(404).send({ error: "not_found" });
    }
    const others = conv.members.filter((m) => m.userId !== userId);
    if (me.role === "ADMIN") {
      const otherAdmins = others.filter((m) => m.role === "ADMIN");
      if (otherAdmins.length === 0 && others.length > 0) {
        // Promote the earliest-joined remaining member.
        const successor = [...others].sort(
          (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
        )[0];
        await prisma.conversationMember.update({
          where: { conversationId_userId: { conversationId: id, userId: successor.userId } },
          data: { role: "ADMIN" },
        });
      }
    }
    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: id, userId } },
    });
    if (others.length === 0) {
      await prisma.conversation.delete({ where: { id } });
    } else {
      await prisma.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
    }
    return { ok: true, id };
  });

  app.delete("/api/conversations/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const gate = await requireGroupAdmin(id, userId);
    if ("error" in gate && gate.error) {
      return reply.code(gate.code).send({ error: gate.error });
    }
    await prisma.conversation.delete({ where: { id } });
    return { ok: true, id };
  });

  app.put("/api/conversations/:id/disappearing", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        seconds: z.number().int().refine((n) => [0, 86400, 604800, 7776000].includes(n), {
          message: "invalid_ttl",
        }),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: id, userId } },
    });
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }
    const updated = await prisma.conversation.update({
      where: { id },
      data: {
        disappearingSeconds: parsed.data.seconds,
        disappearingSetBy: userId,
        disappearingSetAt: new Date(),
      },
      include: memberInclude,
    });
    return toConversationDtoAsync(updated, userId);
  });
}
