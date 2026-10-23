import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";
import { toUserDto } from "../profile.js";

export async function peopleRoutes(app: FastifyInstance) {
  app.get("/api/people/search", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const raw = String((req.query as { q?: string }).q ?? "").trim();
    const digits = raw.replace(/\D/g, "");
    const limit = Math.min(
      100,
      Math.max(1, Number((req.query as { limit?: string }).limit ?? (raw ? 30 : 100)) || 30),
    );

    // Empty query → list all other users (New chat / New group default).
    if (!raw) {
      const users = await prisma.user.findMany({
        where: { id: { not: userId }, bannedAt: null },
        orderBy: [{ displayName: "asc" }, { createdAt: "desc" }],
        take: limit,
      });
      return { items: users.map(toUserDto) };
    }

    if (raw.length < 2 && digits.length < 2) {
      return { items: [] };
    }

    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
        bannedAt: null,
        OR: [
          ...(digits.length >= 2 ? [{ phone: { contains: digits } }] : []),
          ...(raw.length >= 2
            ? [{ displayName: { contains: raw, mode: "insensitive" as const } }]
            : []),
        ],
      },
      orderBy: [{ displayName: "asc" }, { createdAt: "desc" }],
      take: limit,
    });

    return { items: users.map(toUserDto) };
  });
}
