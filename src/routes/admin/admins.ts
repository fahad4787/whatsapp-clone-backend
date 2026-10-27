import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword } from "../../auth/crypto.js";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

export async function adminAdminsRoutes(app: FastifyInstance) {
  app.get("/api/admin/admins", { preHandler: requireAdmin }, async () => {
    const items = await prisma.adminUser.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return {
      items: items.map((a) => ({
        id: a.id,
        email: a.email,
        display_name: a.displayName,
        role: a.role,
        created_at: a.createdAt.toISOString(),
        updated_at: a.updatedAt.toISOString(),
      })),
    };
  });

  app.post("/api/admin/admins", { preHandler: requireAdmin }, async (req, reply) => {
    const actorId = (req as typeof req & { adminId: string }).adminId;
    const actorRole = (req as typeof req & { adminRole: string }).adminRole;
    if (actorRole !== "SUPER") {
      return reply.code(403).send({ error: "super_only" });
    }
    const parsed = z
      .object({
        email: z.string().email(),
        password: z.string().min(8).max(72),
        display_name: z.string().trim().max(80).optional(),
        role: z.enum(["SUPER", "MOD"]).default("MOD"),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const email = parsed.data.email.toLowerCase();
    const clash = await prisma.adminUser.findUnique({ where: { email } });
    if (clash) {
      return reply.code(409).send({ error: "email_taken" });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const created = await prisma.adminUser.create({
      data: {
        email,
        passwordHash,
        displayName: parsed.data.display_name || null,
        role: parsed.data.role,
      },
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId,
        action: "admin.invite",
        meta: { email: created.email, role: created.role },
      },
    });
    return reply.code(201).send({
      id: created.id,
      email: created.email,
      display_name: created.displayName,
      role: created.role,
      created_at: created.createdAt.toISOString(),
    });
  });
}
