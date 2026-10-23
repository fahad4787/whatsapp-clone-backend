import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";

const createBody = z.object({
  target_user_id: z.string().min(1).optional().nullable(),
  target_conversation_id: z.string().min(1).optional().nullable(),
  reason: z.string().trim().max(2000).optional().nullable(),
  message_ids: z.array(z.string().min(1)).max(50).optional().default([]),
  block: z.boolean().optional().default(false),
});

function toReportDto(r: {
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
  reporter?: { id: string; phone: string; displayName: string | null };
  targetUser?: { id: string; phone: string; displayName: string | null } | null;
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
    reporter: r.reporter
      ? {
          id: r.reporter.id,
          phone: r.reporter.phone,
          display_name: r.reporter.displayName,
        }
      : undefined,
    target_user: r.targetUser
      ? {
          id: r.targetUser.id,
          phone: r.targetUser.phone,
          display_name: r.targetUser.displayName,
        }
      : null,
  };
}

export async function reportRoutes(app: FastifyInstance) {
  app.post("/api/reports", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const targetUserId = parsed.data.target_user_id ?? null;
    const targetConversationId = parsed.data.target_conversation_id ?? null;
    if (!targetUserId && !targetConversationId && !parsed.data.reason) {
      return reply.code(400).send({ error: "target_or_reason_required" });
    }
    if (targetUserId === userId) {
      return reply.code(400).send({ error: "cannot_report_self" });
    }
    if (targetUserId) {
      const target = await prisma.user.findUnique({ where: { id: targetUserId } });
      if (!target) {
        return reply.code(404).send({ error: "user_not_found" });
      }
    }

    const report = await prisma.report.create({
      data: {
        reporterId: userId,
        targetUserId,
        targetConversationId,
        reason: parsed.data.reason?.trim() || null,
        messageIds: parsed.data.message_ids,
      },
      include: {
        reporter: { select: { id: true, phone: true, displayName: true } },
        targetUser: { select: { id: true, phone: true, displayName: true } },
      },
    });

    if (parsed.data.block && targetUserId) {
      await prisma.block.upsert({
        where: {
          blockerId_blockedId: { blockerId: userId, blockedId: targetUserId },
        },
        create: { blockerId: userId, blockedId: targetUserId },
        update: {},
      });
    }

    return reply.code(201).send(toReportDto(report));
  });
}
