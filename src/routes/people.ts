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

  /**
   * New chat / group / call pickers.
   * - No query: only people you already share a conversation with (never the whole user base).
   * - Query: find anyone by phone number (>= 7 digits, so the directory cannot be enumerated),
   *   or search your existing contacts by name / number fragment.
   */
  app.get("/api/people/search", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const raw = String((req.query as { q?: string }).q ?? "").trim();
    // Local numbers are often typed with a leading 0 (0300…); stored numbers are international.
    const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
    const limit = Math.min(
      100,
      Math.max(1, Number((req.query as { limit?: string }).limit ?? (raw ? 30 : 100)) || 30),
    );
    const orderBy = [{ displayName: "asc" as const }, { createdAt: "desc" as const }];
    const contactOf = {
      memberships: { some: { conversation: { members: { some: { userId } } } } },
    };
    const base = { id: { not: userId }, bannedAt: null };

    if (!raw) {
      const users = await prisma.user.findMany({
        where: { ...base, ...contactOf },
        orderBy,
        take: limit,
      });
      return { items: users.map(toUserDto) };
    }

    const byNumber = digits.length >= 7 ? [{ phone: { contains: digits } }] : [];
    const inContacts = [
      ...(raw.length >= 2
        ? [{ displayName: { contains: raw, mode: "insensitive" as const } }]
        : []),
      ...(digits.length >= 2 ? [{ phone: { contains: digits } }] : []),
    ];
    const or = [
      ...byNumber,
      ...(inContacts.length ? [{ AND: [contactOf, { OR: inContacts }] }] : []),
    ];
    if (!or.length) return { items: [] };

    const users = await prisma.user.findMany({
      where: { ...base, OR: or },
      orderBy,
      take: limit,
    });
    return { items: users.map(toUserDto) };
  });
}
