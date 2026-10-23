import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

function toAdminUserDto(u: {
  id: string;
  phone: string;
  displayName: string | null;
  about: string | null;
  avatarUrl: string | null;
  bannedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { devices: number; memberships: number };
}) {
  return {
    id: u.id,
    phone: u.phone,
    display_name: u.displayName,
    about: u.about,
    avatar_url: u.avatarUrl,
    banned: Boolean(u.bannedAt),
    banned_at: u.bannedAt?.toISOString() ?? null,
    created_at: u.createdAt.toISOString(),
    updated_at: u.updatedAt.toISOString(),
    device_count: u._count?.devices ?? 0,
    conversation_count: u._count?.memberships ?? 0,
  };
}

export async function adminUserRoutes(app: FastifyInstance) {
  app.get("/api/admin/users", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { q?: string; limit?: string; banned?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));
    const search = q.q?.trim();
    const bannedOnly = q.banned === "1" || q.banned === "true";

    const users = await prisma.user.findMany({
      where: {
        ...(bannedOnly ? { bannedAt: { not: null } } : {}),
        ...(search
          ? {
              OR: [
                { phone: { contains: search } },
                { displayName: { contains: search, mode: "insensitive" } },
                { id: { equals: search } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        _count: { select: { devices: true, memberships: true } },
      },
    });

    return { items: users.map(toAdminUserDto) };
  });

  app.get("/api/admin/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { devices: true, memberships: true } } },
    });
    if (!user) {
      return reply.code(404).send({ error: "not_found" });
    }
    return toAdminUserDto(user);
  });

  app.post("/api/admin/users/:id/ban", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ reason: z.string().trim().max(500).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return reply.code(404).send({ error: "not_found" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { bannedAt: user.bannedAt ?? new Date() },
      include: { _count: { select: { devices: true, memberships: true } } },
    });

    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "user.ban",
        meta: { user_id: id, phone: user.phone, reason: parsed.data.reason ?? null },
      },
    });

    return toAdminUserDto(updated);
  });

  app.post("/api/admin/users/:id/unban", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const { id } = req.params as { id: string };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return reply.code(404).send({ error: "not_found" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { bannedAt: null },
      include: { _count: { select: { devices: true, memberships: true } } },
    });

    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "user.unban",
        meta: { user_id: id, phone: user.phone },
      },
    });

    return toAdminUserDto(updated);
  });
}
