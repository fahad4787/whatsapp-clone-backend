import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";
import { getAdminSecurity, setAdminSecurity } from "../../services/adminSecurity.js";

export async function adminSecurityRoutes(app: FastifyInstance) {
  app.get("/api/admin/security", { preHandler: requireAdmin }, async () => {
    const s = await getAdminSecurity();
    return {
      ...s,
      note: s.require_2fa
        ? "require_2fa is stored but TOTP challenge is not enforced yet."
        : undefined,
    };
  });

  app.put("/api/admin/security", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const parsed = z
      .object({
        require_2fa: z.boolean().optional(),
        lock_after_fail: z.boolean().optional(),
        session_hours: z.number().int().min(1).max(168).optional(),
        max_fail_attempts: z.number().int().min(3).max(20).optional(),
        lock_minutes: z.number().int().min(1).max(1440).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const s = await setAdminSecurity(parsed.data);
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "security.update",
        meta: { ...s },
      },
    });
    return {
      ...s,
      note: s.require_2fa
        ? "TOTP is required at admin login. Unenrolled admins get an enrollment ticket."
        : undefined,
    };
  });
}
