import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";

export async function meRoutes(app: FastifyInstance) {
  app.get("/api/me", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send({ error: "not_found" });
    }
    return {
      id: user.id,
      phone: user.phone,
      display_name: user.displayName,
      about: user.about,
      avatar_url: user.avatarUrl,
    };
  });
}
