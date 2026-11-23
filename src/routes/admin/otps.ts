import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { generateOtpCode, hashSha256 } from "../../auth/crypto.js";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

const MAX_ATTEMPTS = 5;

export async function adminOtpRoutes(app: FastifyInstance) {
  app.get("/api/admin/otps", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));

    const rows = await prisma.otpChallenge.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const now = Date.now();
    // Rows are newest-first, so any newer code for the same identifier + purpose appears earlier in the list.
    const seen = new Set<string>();
    return {
      items: rows.map((r) => {
        const key = `${r.phone}|${r.purpose}`;
        const hasNewer = seen.has(key);
        seen.add(key);

        let status: "Pending" | "Used" | "Expired" | "Failed" | "Superseded" = "Pending";
        if (r.consumedAt) status = "Used";
        else if (r.attempts >= MAX_ATTEMPTS) status = "Failed";
        else if (r.expiresAt.getTime() < now) status = "Expired";
        else if (hasNewer) status = "Superseded";

        return {
          id: r.id,
          phone: r.phone,
          channel: r.phone.includes("@") ? "email" : "phone",
          purpose: r.purpose,
          // Only a still-usable code is shown to operators; spent codes are never exposed again.
          code: status === "Pending" ? r.devCode : null,
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
        devCode: config.otpAdminDelivery ? code : null,
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
