import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

export async function adminOtpRoutes(app: FastifyInstance) {
  app.get("/api/admin/otps", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));

    const rows = await prisma.otpChallenge.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const now = Date.now();
    return {
      items: rows.map((r) => {
        let status = "Pending";
        if (r.consumedAt) status = "Used";
        else if (r.expiresAt.getTime() < now) status = "Expired";
        else if (r.attempts >= 5) status = "Failed";

        return {
          id: r.id,
          phone: r.phone,
          code: r.devCode,
          status,
          attempts: r.attempts,
          expires_at: r.expiresAt.toISOString(),
          created_at: r.createdAt.toISOString(),
          consumed_at: r.consumedAt?.toISOString() ?? null,
        };
      }),
    };
  });
}
