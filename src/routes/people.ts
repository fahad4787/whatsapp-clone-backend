import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { canOpenProfileLink } from "../privacy.js";
import { requireUser } from "../plugins/auth.js";
import { toUserDto } from "../profile.js";

export async function peopleRoutes(app: FastifyInstance) {
  /** Public landing for shared profile QR links (opens app via intent / scheme). */
  app.get("/u/:id", async (req, reply) => {
    const id = String((req.params as { id?: string }).id ?? "").trim();
    if (!id) return reply.code(400).send("missing id");
    const deep = `aivora://user/${encodeURIComponent(id)}`;
    return reply
      .type("text/html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Aivora</title></head><body style="font-family:system-ui;padding:2rem;text-align:center"><h1>Open in Aivora</h1><p><a href="${deep}">Tap to chat</a></p><p style="color:#666;font-size:14px">Install Aivora if the link does nothing.</p></body></html>`,
      );
  });

  /** Wave 38/39 — resolve a profile QR / deep-link user id (respects links privacy). */
  app.get("/api/users/:id", { preHandler: requireUser }, async (req, reply) => {
    const me = (req as typeof req & { userId: string }).userId;
    const id = String((req.params as { id?: string }).id ?? "").trim();
    if (!id) return reply.code(400).send({ error: "invalid_id" });
    const user = await prisma.user.findFirst({
      where: { id, bannedAt: null },
    });
    if (!user) return reply.code(404).send({ error: "not_found" });
    if (user.id === me) return reply.code(400).send({ error: "self" });
    if (!(await canOpenProfileLink(me, id))) {
      return reply.code(403).send({ error: "links_privacy" });
    }
    return toUserDto(user);
  });

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
