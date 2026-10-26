import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";
import { realtimeHub } from "../realtime/hub.js";
import { toStatusItemDto, toStatusRowDto } from "../status.js";
import {
  asIdList,
  canViewerSeeStatus,
  eligibleStatusRecipients,
  type StatusAudience,
} from "../statusPrivacy.js";
import { toUserDto } from "../profile.js";

const AUDIENCE = z.enum(["everyone", "contacts", "contacts_except", "only_share"]);

const attachmentSchema = z
  .object({
    key: z.string().min(1).max(200),
    url: z.string().url().max(2000),
    mime: z.string().min(3).max(100).optional(),
    size: z.number().int().nonnegative().optional(),
    name: z.string().max(200).optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    duration: z.number().int().nonnegative().optional(),
    thumbnail_url: z.string().url().max(2000).optional(),
    thumbnail_key: z.string().max(200).optional(),
  })
  .optional();

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startStatusCleanup() {
  if (cleanupTimer || process.env.NODE_ENV === "test") return;
  cleanupTimer = setInterval(() => {
    void prisma.status
      .deleteMany({ where: { expiresAt: { lte: new Date() } } })
      .catch(() => undefined);
  }, 15 * 60 * 1000);
  cleanupTimer.unref?.();
}

export async function statusRoutes(app: FastifyInstance) {
  startStatusCleanup();

  app.get("/api/status", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const now = new Date();

    const mine = await prisma.status.findMany({
      where: { userId, expiresAt: { gt: now } },
      include: { views: true, user: true },
      orderBy: { createdAt: "desc" },
    });

    const others = await prisma.status.findMany({
      where: {
        userId: { not: userId },
        expiresAt: { gt: now },
        user: { bannedAt: null },
      },
      include: { views: true, user: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    const visibleOthers: typeof others = [];
    for (const s of others) {
      const ok = await canViewerSeeStatus({
        authorId: s.userId,
        viewerId: userId,
        audience: s.audience,
        audienceIds: s.audienceIds,
      });
      if (ok) visibleOthers.push(s);
    }

    const byAuthor = new Map<string, typeof others>();
    for (const s of visibleOthers) {
      const list = byAuthor.get(s.userId) ?? [];
      list.push(s);
      byAuthor.set(s.userId, list);
    }

    const meUser =
      mine[0]?.user ??
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }));

    const items = [];
    if (mine.length > 0) {
      items.push(toStatusRowDto(meUser, mine, userId));
    } else {
      items.push({
        user: toUserDto(meUser),
        statuses: [] as ReturnType<typeof toStatusItemDto>[],
        unseen: "0",
        latest_at: null as string | null,
      });
    }

    const peerRows = [...byAuthor.entries()]
      .map(([, list]) => toStatusRowDto(list[0]!.user, list, userId))
      .sort((a, b) => (b.latest_at ?? "").localeCompare(a.latest_at ?? ""));

    items.push(...peerRows);
    return { items };
  });

  app.post("/api/status", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        kind: z.enum(["text", "image", "video"]).optional(),
        text: z.string().trim().max(700).optional().nullable(),
        background: z.string().max(40).optional().nullable(),
        attachment: attachmentSchema,
        audience: AUDIENCE.optional(),
        audience_ids: z.array(z.string().min(1)).max(200).optional(),
      })
      .refine(
        (b) =>
          (b.text && b.text.length > 0) || b.attachment,
        { message: "status_required" },
      )
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const me = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const audience = (parsed.data.audience ??
      (me.statusPrivacy as StatusAudience) ??
      "contacts") as StatusAudience;
    const audienceIds =
      parsed.data.audience_ids ?? asIdList(me.statusPrivacyIds);

    let kind = parsed.data.kind ?? "text";
    if (parsed.data.attachment) {
      const mime = parsed.data.attachment.mime ?? "";
      if (mime.startsWith("video/")) kind = "video";
      else if (mime.startsWith("image/")) kind = "image";
      else if (!parsed.data.kind) kind = "image";
    }

    const now = new Date();
    const created = await prisma.status.create({
      data: {
        userId,
        kind,
        text: parsed.data.text?.trim() || null,
        background: parsed.data.background ?? null,
        attachment: parsed.data.attachment ?? undefined,
        audience,
        audienceIds,
        expiresAt: new Date(now.getTime() + STATUS_TTL_MS),
      },
      include: { views: true, user: true },
    });

    const item = toStatusItemDto(created, userId);
    const recipients = await eligibleStatusRecipients({
      authorId: userId,
      audience,
      audienceIds,
    });
    const row = toStatusRowDto(created.user, [created], userId);
    for (const peerId of recipients) {
      realtimeHub.toUser(peerId, { type: "status.new", data: row });
    }

    return reply.code(201).send(item);
  });

  app.post("/api/status/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const status = await prisma.status.findUnique({
      where: { id },
      include: { views: true },
    });
    if (!status || status.expiresAt.getTime() <= Date.now()) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (status.userId === userId) {
      return { ok: true, seen: true };
    }
    const ok = await canViewerSeeStatus({
      authorId: status.userId,
      viewerId: userId,
      audience: status.audience,
      audienceIds: status.audienceIds,
    });
    if (!ok) return reply.code(404).send({ error: "not_found" });

    await prisma.statusView.upsert({
      where: { statusId_userId: { statusId: id, userId } },
      create: { statusId: id, userId },
      update: { seenAt: new Date() },
    });
    const viewCount = await prisma.statusView.count({ where: { statusId: id } });
    realtimeHub.toUser(status.userId, {
      type: "status.viewed",
      data: { status_id: id, view_count: viewCount },
    });
    return { ok: true, seen: true, view_count: viewCount };
  });

  app.get("/api/status/:id/viewers", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const status = await prisma.status.findUnique({ where: { id } });
    if (!status || status.userId !== userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const views = await prisma.statusView.findMany({
      where: { statusId: id },
      include: { user: true },
      orderBy: { seenAt: "desc" },
    });
    return {
      items: views.map((v) => ({
        user: toUserDto(v.user),
        created_at: v.createdAt.toISOString(),
        seen_at: v.seenAt.toISOString(),
        reaction: v.reaction,
      })),
    };
  });

  app.delete("/api/status/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const status = await prisma.status.findUnique({ where: { id } });
    if (!status || status.userId !== userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const recipients = await eligibleStatusRecipients({
      authorId: userId,
      audience: status.audience as StatusAudience,
      audienceIds: status.audienceIds,
    });
    await prisma.status.delete({ where: { id } });
    for (const peerId of recipients) {
      realtimeHub.toUser(peerId, {
        type: "status.deleted",
        data: { status_id: id, user_id: userId },
      });
    }
    return { ok: true };
  });

  app.post("/api/status/:id/reaction", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ reaction: z.string().trim().min(1).max(16).nullable() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const status = await prisma.status.findUnique({ where: { id } });
    if (!status || status.expiresAt.getTime() <= Date.now()) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (status.userId === userId) {
      return reply.code(400).send({ error: "cannot_react_own" });
    }
    const ok = await canViewerSeeStatus({
      authorId: status.userId,
      viewerId: userId,
      audience: status.audience,
      audienceIds: status.audienceIds,
    });
    if (!ok) return reply.code(404).send({ error: "not_found" });

    const view = await prisma.statusView.upsert({
      where: { statusId_userId: { statusId: id, userId } },
      create: {
        statusId: id,
        userId,
        reaction: parsed.data.reaction,
      },
      update: {
        reaction: parsed.data.reaction,
        seenAt: new Date(),
      },
    });
    return { ok: true, reaction: view.reaction };
  });
}
