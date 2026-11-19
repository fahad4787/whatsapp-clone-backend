import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

function slugify(raw: string): string {
  return (
    raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || `channel-${Date.now()}`
  );
}

async function ensureSeedChannels() {
  const count = await prisma.channel.count();
  if (count > 0) return;
  await prisma.channel.create({
    data: {
      name: "Aivora News",
      slug: "aivora-news",
      description: "Official product news and tips.",
      verified: true,
      listed: true,
      posts: {
        create: [{ text: "Welcome to Aivora News — follow for product updates." }],
      },
    },
  });
}

export async function adminChannelRoutes(app: FastifyInstance) {
  app.get("/api/admin/channels", { preHandler: requireAdmin }, async () => {
    await ensureSeedChannels();
    const rows = await prisma.channel.findMany({
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        _count: { select: { followers: true, posts: true } },
      },
    });
    return {
      items: rows.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        verified: c.verified,
        listed: c.listed,
        followers: c._count.followers,
        posts: c._count.posts,
        created_at: c.createdAt.toISOString(),
        updated_at: c.updatedAt.toISOString(),
      })),
    };
  });

  app.post("/api/admin/channels", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(80),
        slug: z.string().trim().min(2).max(64).optional(),
        description: z.string().trim().max(500).optional().nullable(),
        verified: z.boolean().optional(),
        listed: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    let slug = slugify(parsed.data.slug ?? parsed.data.name);
    const clash = await prisma.channel.findUnique({ where: { slug } });
    if (clash) slug = `${slug}-${Date.now().toString(36)}`;
    const c = await prisma.channel.create({
      data: {
        name: parsed.data.name,
        slug,
        description: parsed.data.description ?? null,
        verified: parsed.data.verified ?? false,
        listed: parsed.data.listed ?? true,
      },
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "channel.create",
        meta: { id: c.id, slug: c.slug },
      },
    });
    return reply.code(201).send({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      verified: c.verified,
      listed: c.listed,
      followers: 0,
      posts: 0,
      created_at: c.createdAt.toISOString(),
      updated_at: c.updatedAt.toISOString(),
    });
  });

  app.patch("/api/admin/channels/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        description: z.string().trim().max(500).optional().nullable(),
        verified: z.boolean().optional(),
        listed: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const existing = await prisma.channel.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const c = await prisma.channel.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        ...(parsed.data.verified !== undefined ? { verified: parsed.data.verified } : {}),
        ...(parsed.data.listed !== undefined ? { listed: parsed.data.listed } : {}),
      },
      include: { _count: { select: { followers: true, posts: true } } },
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "channel.update",
        meta: { id: c.id, listed: c.listed, verified: c.verified },
      },
    });
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      verified: c.verified,
      listed: c.listed,
      followers: c._count.followers,
      posts: c._count.posts,
      created_at: c.createdAt.toISOString(),
      updated_at: c.updatedAt.toISOString(),
    };
  });

  app.delete("/api/admin/channels/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const { id } = req.params as { id: string };
    const existing = await prisma.channel.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await prisma.channel.delete({ where: { id } });
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "channel.delete",
        meta: { id, slug: existing.slug },
      },
    });
    return { ok: true };
  });

  app.get("/api/admin/channels/:id/posts", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ch = await prisma.channel.findUnique({ where: { id } });
    if (!ch) return reply.code(404).send({ error: "not_found" });
    const posts = await prisma.channelPost.findMany({
      where: { channelId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      items: posts.map((p) => ({
        id: p.id,
        text: p.text,
        deleted: Boolean(p.deletedAt),
        view_count: p.viewCount,
        created_at: p.createdAt.toISOString(),
      })),
    };
  });

  app.delete(
    "/api/admin/channels/:id/posts/:postId",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const adminId = (req as typeof req & { adminId: string }).adminId;
      const { id, postId } = req.params as { id: string; postId: string };
      const post = await prisma.channelPost.findFirst({
        where: { id: postId, channelId: id },
      });
      if (!post) return reply.code(404).send({ error: "not_found" });
      await prisma.channelPost.update({
        where: { id: postId },
        data: { deletedAt: new Date() },
      });
      await prisma.adminAuditLog.create({
        data: {
          actorId: adminId,
          action: "channel.post.hide",
          meta: { channelId: id, postId },
        },
      });
      return { ok: true };
    },
  );
}
