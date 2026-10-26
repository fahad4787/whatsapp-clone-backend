import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

function toAdminReportDto(r: {
  id: string;
  reporterId: string;
  targetUserId: string | null;
  targetConversationId: string | null;
  reason: string | null;
  messageIds: unknown;
  status: string;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  resolvedByAdminId: string | null;
  createdAt: Date;
  updatedAt: Date;
  reporter: { id: string; phone: string; displayName: string | null };
  targetUser: { id: string; phone: string; displayName: string | null } | null;
}) {
  return {
    id: r.id,
    reporter_id: r.reporterId,
    target_user_id: r.targetUserId,
    target_conversation_id: r.targetConversationId,
    reason: r.reason,
    message_ids: Array.isArray(r.messageIds) ? r.messageIds : [],
    status: r.status.toLowerCase(),
    resolution_note: r.resolutionNote,
    resolved_at: r.resolvedAt?.toISOString() ?? null,
    resolved_by_admin_id: r.resolvedByAdminId,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    reporter: {
      id: r.reporter.id,
      phone: r.reporter.phone,
      display_name: r.reporter.displayName,
    },
    target_user: r.targetUser
      ? {
          id: r.targetUser.id,
          phone: r.targetUser.phone,
          display_name: r.targetUser.displayName,
        }
      : null,
  };
}

export async function adminReportRoutes(app: FastifyInstance) {
  app.get("/api/admin/reports", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { status?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));
    const statusRaw = q.status?.trim().toUpperCase();
    const status =
      statusRaw === "OPEN" || statusRaw === "RESOLVED" || statusRaw === "DISMISSED"
        ? statusRaw
        : undefined;

    const rows = await prisma.report.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        reporter: { select: { id: true, phone: true, displayName: true } },
        targetUser: { select: { id: true, phone: true, displayName: true } },
      },
    });

    const allMessageIds = [
      ...new Set(
        rows.flatMap((r) => (Array.isArray(r.messageIds) ? (r.messageIds as string[]) : [])),
      ),
    ].slice(0, 200);
    const messages =
      allMessageIds.length === 0
        ? []
        : await prisma.message.findMany({
            where: { id: { in: allMessageIds } },
            select: {
              id: true,
              type: true,
              text: true,
              conversationId: true,
              deletedForEveryoneAt: true,
              createdAt: true,
            },
          });
    const msgMap = new Map(messages.map((m) => [m.id, m]));

    return {
      items: rows.map((r) => {
        const base = toAdminReportDto(r);
        const ids = Array.isArray(r.messageIds) ? (r.messageIds as string[]) : [];
        return {
          ...base,
          messages: ids
            .map((mid) => msgMap.get(mid))
            .filter(Boolean)
            .map((m) => ({
              id: m!.id,
              conversation_id: m!.conversationId,
              type: m!.type.toLowerCase(),
              text: m!.deletedForEveryoneAt
                ? "This message was deleted"
                : m!.text?.slice(0, 160) ?? m!.type.toLowerCase(),
              created_at: m!.createdAt.toISOString(),
            })),
        };
      }),
    };
  });

  app.post("/api/admin/reports/:id/resolve", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        action: z.enum(["resolve", "dismiss"]).default("resolve"),
        note: z.string().trim().max(1000).optional(),
        ban_user: z.boolean().optional().default(false),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const existing = await prisma.report.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: "not_found" });
    }

    const status = parsed.data.action === "dismiss" ? "DISMISSED" : "RESOLVED";
    const updated = await prisma.report.update({
      where: { id },
      data: {
        status,
        resolutionNote: parsed.data.note ?? null,
        resolvedAt: new Date(),
        resolvedByAdminId: adminId,
      },
      include: {
        reporter: { select: { id: true, phone: true, displayName: true } },
        targetUser: { select: { id: true, phone: true, displayName: true } },
      },
    });

    if (parsed.data.ban_user && existing.targetUserId) {
      await prisma.user.update({
        where: { id: existing.targetUserId },
        data: { bannedAt: new Date() },
      });
      await prisma.refreshToken.updateMany({
        where: { userId: existing.targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: `report.${parsed.data.action}`,
        meta: {
          report_id: id,
          ban_user: parsed.data.ban_user,
          target_user_id: existing.targetUserId,
        },
      },
    });

    return toAdminReportDto(updated);
  });
}
