import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyPassword } from "../../auth/crypto.js";
import { signAdminToken } from "../../auth/jwt.js";
import { prisma } from "../../db.js";

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post("/api/admin/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const admin = await prisma.adminUser.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
    });
    if (!admin) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const ok = await verifyPassword(parsed.data.password, admin.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    await prisma.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: "admin.login",
        meta: { email: admin.email },
      },
    });

    return {
      access: signAdminToken(admin.id, admin.role),
      admin: {
        id: admin.id,
        email: admin.email,
        display_name: admin.displayName,
        role: admin.role,
      },
    };
  });
}
