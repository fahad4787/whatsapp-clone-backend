import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";

async function ensureSeedChannels() {
  const count = await prisma.channel.count();
  if (count > 0) return;
  const news = await prisma.channel.create({
    data: {
      name: "Aivora News",
      slug: "aivora-news",
      description: "Official product news and tips.",
      verified: true,
      listed: true,
      posts: {
        create: [
          { text: "Welcome to Aivora News — follow for product updates." },
          { text: "Wave 21 channels are live. Tap Follow to get posts here." },
        ],
      },
    },
  });
  await prisma.channel.create({
    data: {
      name: "Aivora Updates",
      slug: "aivora-updates",
      description: "Release notes and maintenance notices.",
      listed: true,
      posts: {
        create: [{ text: "Today's briefing: identity, chrome, and channels shipped." }],
      },
    },
  });
  void news;
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || `channel-${Date.now()}`;
}

async function toChannelDto(channelId: string, userId: string | null) {
  const ch = await prisma.channel.findUnique({
    where: { id: channelId },
    include: {
      _count: { select: { followers: true, posts: true } },
      posts: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      followers: userId
        ? { where: { userId }, take: 1 }
        : { take: 0 },
    },
  });
  if (!ch) return null;
  const follow = ch.followers[0];
  const last = ch.posts[0];
  return {
    id: ch.id,
    name: ch.name,
    slug: ch.slug,
    description: ch.description,
    avatar_url: ch.avatarUrl,
    verified: ch.verified,
    listed: ch.listed,
    follower_count: ch._count.followers,
    last_post_at: last?.createdAt.toISOString() ?? null,
    following: Boolean(follow),
    muted: follow?.muted ?? false,
    is_admin: userId != null && ch.ownerId === userId,
    unread_count: 0,
    last_post_preview: last?.text?.slice(0, 120) ?? null,
  };
}

async function toPostDto(postId: string, userId: string | null) {
  const post = await prisma.channelPost.findUnique({
    where: { id: postId },
    include: { reactions: true },
  });
  if (!post || post.deletedAt) return null;
  const byEmoji = new Map<string, number>();
  for (const r of post.reactions) {
    byEmoji.set(r.emoji, (byEmoji.get(r.emoji) ?? 0) + 1);
  }
  const mine = userId
    ? post.reactions.find((r) => r.userId === userId)?.emoji ?? null
    : null;
  return {
    id: post.id,
    text: post.text,
    created_at: post.createdAt.toISOString(),
    edited_at: null,
    deleted: false,
    view_count: post.viewCount,
    reactions: [...byEmoji.entries()].map(([emoji, count]) => ({ emoji, count })),
    my_reaction: mine,
  };
}

export async function channelRoutes(app: FastifyInstance) {
  app.get("/api/channels", { preHandler: requireUser }, async (req) => {
    await ensureSeedChannels();
    const userId = (req as typeof req & { userId: string }).userId;
    const q = (req.query as { q?: string }).q?.trim();
    const rows = await prisma.channel.findMany({
      where: {
        listed: true,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { slug: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    const items = [];
    for (const r of rows) {
      const dto = await toChannelDto(r.id, userId);
      if (dto) items.push(dto);
    }
    return { items };
  });

  app.post("/api/channels", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(80),
        slug: z.string().trim().min(2).max(64).optional(),
        description: z.string().trim().max(500).optional().nullable(),
        listed: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    let slug = parsed.data.slug ? slugify(parsed.data.slug) : slugify(parsed.data.name);
    const taken = await prisma.channel.findUnique({ where: { slug } });
    if (taken) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const ch = await prisma.channel.create({
      data: {
        name: parsed.data.name,
        slug,
        description: parsed.data.description ?? null,
        listed: parsed.data.listed ?? true,
        ownerId: userId,
      },
    });
    await prisma.channelFollow.create({
      data: { channelId: ch.id, userId },
    });
    return reply.code(201).send(await toChannelDto(ch.id, userId));
  });

  app.get("/api/channels/:slug", { preHandler: requireUser }, async (req, reply) => {
    await ensureSeedChannels();
    const userId = (req as typeof req & { userId: string }).userId;
    const { slug } = req.params as { slug: string };
    const ch = await prisma.channel.findUnique({ where: { slug } });
    if (!ch) return reply.code(404).send({ error: "not_found" });
    return toChannelDto(ch.id, userId);
  });

  app.get("/api/channels/:slug/posts", { preHandler: requireUser }, async (req, reply) => {
    await ensureSeedChannels();
    const userId = (req as typeof req & { userId: string }).userId;
    const { slug } = req.params as { slug: string };
    const ch = await prisma.channel.findUnique({ where: { slug } });
    if (!ch) return reply.code(404).send({ error: "not_found" });
    const posts = await prisma.channelPost.findMany({
      where: { channelId: ch.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    // Bump view counts lightly
    if (posts.length > 0) {
      await prisma.channelPost.updateMany({
        where: { id: { in: posts.map((p) => p.id) } },
        data: { viewCount: { increment: 1 } },
      });
    }
    const items = [];
    for (const p of posts) {
      const dto = await toPostDto(p.id, userId);
      if (dto) items.push(dto);
    }
    return { items };
  });

  app.post("/api/channels/:slug/posts", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { slug } = req.params as { slug: string };
    const parsed = z
      .object({ text: z.string().trim().min(1).max(4000) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const ch = await prisma.channel.findUnique({ where: { slug } });
    if (!ch) return reply.code(404).send({ error: "not_found" });
    if (ch.ownerId && ch.ownerId !== userId) {
      return reply.code(403).send({ error: "forbidden" });
    }
    // Seed channels (no owner): allow any authenticated user to post (thin staging).
    const post = await prisma.channelPost.create({
      data: {
        channelId: ch.id,
        authorId: userId,
        text: parsed.data.text,
      },
    });
    await prisma.channel.update({
      where: { id: ch.id },
      data: { updatedAt: new Date() },
    });
    return reply.code(201).send(await toPostDto(post.id, userId));
  });

  app.post("/api/channels/:slug/follow", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { slug } = req.params as { slug: string };
    const parsed = z
      .object({ muted: z.boolean().optional() })
      .safeParse(req.body ?? {});
    const ch = await prisma.channel.findUnique({ where: { slug } });
    if (!ch) return reply.code(404).send({ error: "not_found" });
    await prisma.channelFollow.upsert({
      where: { channelId_userId: { channelId: ch.id, userId } },
      create: {
        channelId: ch.id,
        userId,
        muted: parsed.success ? Boolean(parsed.data.muted) : false,
      },
      update: {
        muted: parsed.success && parsed.data.muted !== undefined
          ? parsed.data.muted
          : undefined,
      },
    });
    return toChannelDto(ch.id, userId);
  });

  app.delete("/api/channels/:slug/follow", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { slug } = req.params as { slug: string };
    const ch = await prisma.channel.findUnique({ where: { slug } });
    if (!ch) return reply.code(404).send({ error: "not_found" });
    await prisma.channelFollow.deleteMany({
      where: { channelId: ch.id, userId },
    });
    return toChannelDto(ch.id, userId);
  });

  app.post(
    "/api/channels/:slug/posts/:postId/reaction",
    { preHandler: requireUser },
    async (req, reply) => {
      const userId = (req as typeof req & { userId: string }).userId;
      const { slug, postId } = req.params as { slug: string; postId: string };
      const parsed = z
        .object({ emoji: z.string().min(1).max(16) })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const ch = await prisma.channel.findUnique({ where: { slug } });
      if (!ch) return reply.code(404).send({ error: "not_found" });
      const post = await prisma.channelPost.findFirst({
        where: { id: postId, channelId: ch.id, deletedAt: null },
      });
      if (!post) return reply.code(404).send({ error: "not_found" });
      await prisma.channelPostReaction.upsert({
        where: { postId_userId: { postId, userId } },
        create: { postId, userId, emoji: parsed.data.emoji },
        update: { emoji: parsed.data.emoji },
      });
      return toPostDto(postId, userId);
    },
  );

  app.post("/api/channels/:slug/report", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { slug } = req.params as { slug: string };
    const parsed = z
      .object({ reason: z.string().trim().min(2).max(500).optional() })
      .safeParse(req.body ?? {});
    const ch = await prisma.channel.findUnique({ where: { slug } });
    if (!ch) return reply.code(404).send({ error: "not_found" });
    await prisma.report.create({
      data: {
        reporterId: userId,
        reason: parsed.success
          ? `channel:${slug}:${parsed.data.reason ?? "report"}`
          : `channel:${slug}`,
      },
    });
    return reply.code(201).send({ ok: true });
  });
}
