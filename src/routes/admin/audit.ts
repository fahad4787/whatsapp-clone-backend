import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

export async function adminAuditRoutes(app: FastifyInstance) {
  app.get("/api/admin/audit", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const rows = await prisma.adminAuditLog.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        actor: { select: { id: true, email: true, displayName: true } },
      },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        meta: r.meta,
        created_at: r.createdAt.toISOString(),
        actor: {
          id: r.actor.id,
          email: r.actor.email,
          display_name: r.actor.displayName,
        },
      })),
    };
  });
}
