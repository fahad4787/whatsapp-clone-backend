import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { generateOtpCode, hashSha256 } from "../../auth/crypto.js";
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

  // Generate a fresh login code for a phone (support / testing). Audited.
  app.post("/api/admin/otps/generate", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const parsed = z.object({ phone: z.string().trim().regex(/^\+\d{7,15}$/) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_phone" });
    const user = await prisma.user.findUnique({ where: { phone: parsed.data.phone } });
    if (user?.bannedAt) return reply.code(403).send({ error: "banned" });
    const code = generateOtpCode();
    const row = await prisma.otpChallenge.create({
      data: {
        phone: parsed.data.phone,
        codeHash: hashSha256(code),
        devCode: config.otpDevBypass ? code : null,
        purpose: "login",
        expiresAt: new Date(Date.now() + config.otpTtlSec * 1000),
        userId: user?.id ?? null,
      },
    });
    await prisma.adminAuditLog.create({
      data: { actorId: adminId, action: "otp.generate", meta: { phone: parsed.data.phone } },
    });
    // Code is returned once so the operator can read it out; never stored in plaintext in live-SMS mode.
    return reply.code(201).send({ id: row.id, phone: row.phone, code });
  });
}
