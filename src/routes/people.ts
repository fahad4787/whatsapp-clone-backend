import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";
import { toUserDto } from "../profile.js";

export async function peopleRoutes(app: FastifyInstance) {
  app.get("/api/people/search", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const q = String((req.query as { q?: string }).q ?? "").trim();
    const limit = Math.min(50, Math.max(1, Number((req.query as { limit?: string }).limit ?? 30) || 30));

    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
        bannedAt: null,
        ...(q
          ? {
              OR: [
                { phone: { contains: q.replace(/\s/g, "") } },
                { displayName: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return { items: users.map(toUserDto) };
  });
}
