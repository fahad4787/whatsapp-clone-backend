import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

function previewText(msg: {
  type: string;
  text: string | null;
  deletedForEveryoneAt: Date | null;
} | null): string | null {
  if (!msg) return null;
  if (msg.deletedForEveryoneAt) return "Message deleted";
  if (msg.text?.trim()) return msg.text.trim().slice(0, 120);
  return msg.type.toLowerCase();
}

export async function adminConversationRoutes(app: FastifyInstance) {
  app.get("/api/admin/conversations", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { q?: string; type?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));
    const search = q.q?.trim();
    const typeRaw = q.type?.trim().toUpperCase();
    const type =
      typeRaw === "GROUP" || typeRaw === "DIRECT" ? typeRaw : undefined;

    const rows = await prisma.conversation.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: "insensitive" } },
                { id: { equals: search } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      include: {
        members: {
          include: {
            user: { select: { id: true, phone: true, displayName: true } },
          },
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            type: true,
            text: true,
            createdAt: true,
            deletedForEveryoneAt: true,
          },
        },
        _count: { select: { messages: true, members: true } },
      },
    });

    return {
      items: rows.map((c) => {
        const last = c.messages[0] ?? null;
        const title =
          c.type === "GROUP"
            ? c.title || "Group"
            : c.members
                .map((m) => m.user.displayName || m.user.phone)
                .filter(Boolean)
                .join(" · ") || "Direct";
        return {
          id: c.id,
          type: c.type.toLowerCase(),
          title,
          description: c.description,
          avatar_url: c.avatarUrl,
          member_count: c._count.members,
          message_count: c._count.messages,
          disappearing_seconds: c.disappearingSeconds,
          only_admins_can_send: c.onlyAdminsCanSend,
          only_admins_can_edit_info: c.onlyAdminsCanEditInfo,
          created_at: c.createdAt.toISOString(),
          updated_at: c.updatedAt.toISOString(),
          last_message_at: last?.createdAt.toISOString() ?? null,
          last_message_preview: previewText(last),
          members: c.members.map((m) => ({
            user_id: m.user.id,
            phone: m.user.phone,
            display_name: m.user.displayName,
            role: m.role === "ADMIN" ? "admin" : "member",
          })),
        };
      }),
    };
  });

  app.get("/api/admin/conversations/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 40) || 40));

    const c = await prisma.conversation.findUnique({
      where: { id },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                phone: true,
                displayName: true,
                bannedAt: true,
              },
            },
          },
        },
        _count: { select: { messages: true, members: true } },
      },
    });
    if (!c) {
      return reply.code(404).send({ error: "not_found" });
    }

    const messages = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        senderId: true,
        type: true,
        text: true,
        status: true,
        forwarded: true,
        viewOnce: true,
        editedAt: true,
        expiresAt: true,
        deletedForEveryoneAt: true,
        createdAt: true,
        attachment: true,
      },
    });

    const senderIds = [...new Set(messages.map((m) => m.senderId))];
    const senders = await prisma.user.findMany({
      where: { id: { in: senderIds } },
      select: { id: true, phone: true, displayName: true },
    });
    const senderMap = new Map(senders.map((s) => [s.id, s]));

    const title =
      c.type === "GROUP"
        ? c.title || "Group"
        : c.members
            .map((m) => m.user.displayName || m.user.phone)
            .filter(Boolean)
            .join(" · ") || "Direct";

    return {
      id: c.id,
      type: c.type.toLowerCase(),
      title,
      description: c.description,
      avatar_url: c.avatarUrl,
      member_count: c._count.members,
      message_count: c._count.messages,
      disappearing_seconds: c.disappearingSeconds,
      only_admins_can_send: c.onlyAdminsCanSend,
      only_admins_can_edit_info: c.onlyAdminsCanEditInfo,
      created_at: c.createdAt.toISOString(),
      updated_at: c.updatedAt.toISOString(),
      members: c.members.map((m) => ({
        user_id: m.user.id,
        phone: m.user.phone,
        display_name: m.user.displayName,
        role: m.role === "ADMIN" ? "admin" : "member",
        banned: Boolean(m.user.bannedAt),
      })),
      messages: messages.map((m) => {
        const sender = senderMap.get(m.senderId);
        const att = m.attachment as { url?: string; mime?: string; name?: string } | null;
        return {
          id: m.id,
          sender_id: m.senderId,
          sender_name: sender?.displayName || sender?.phone || m.senderId,
          type: m.type.toLowerCase(),
          text: m.deletedForEveryoneAt
            ? "This message was deleted"
            : m.text,
          status: m.status.toLowerCase(),
          forwarded: m.forwarded,
          view_once: m.viewOnce,
          edited_at: m.editedAt?.toISOString() ?? null,
          expires_at: m.expiresAt?.toISOString() ?? null,
          deleted_for_everyone_at: m.deletedForEveryoneAt?.toISOString() ?? null,
          created_at: m.createdAt.toISOString(),
          attachment_name: att?.name ?? null,
          attachment_mime: att?.mime ?? null,
          has_attachment: Boolean(att?.url),
        };
      }),
    };
  });
}
