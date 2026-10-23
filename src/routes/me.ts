import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";
import { toUserDto } from "../profile.js";

const updateBody = z
  .object({
    display_name: z.string().trim().min(1).max(80).optional(),
    about: z.string().trim().max(500).optional(),
  })
  .refine((b) => b.display_name !== undefined || b.about !== undefined, {
    message: "empty",
  });

const AVATAR_DIR = path.join(process.cwd(), "uploads", "avatars");

function publicUrl(relativePath: string): string {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  return `${base}${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}`;
}

function extFromMime(mime: string | undefined): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

export async function meRoutes(app: FastifyInstance) {
  app.get("/api/me", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send({ error: "not_found" });
    }
    return toUserDto(user);
  });

  app.put("/api/me", { preHandler: requireUser }, async (req, reply) => {
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const userId = (req as typeof req & { userId: string }).userId;
    const data: { displayName?: string; about?: string } = {};
    if (parsed.data.display_name !== undefined) data.displayName = parsed.data.display_name;
    if (parsed.data.about !== undefined) data.about = parsed.data.about;

    const user = await prisma.user.update({ where: { id: userId }, data });
    return toUserDto(user);
  });

  app.get("/api/me/privacy", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    return {
      last_seen: user.lastSeenPrivacy,
      online: user.onlinePrivacy,
    };
  });

  app.put("/api/me/privacy", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        last_seen: z.enum(["everyone", "contacts", "nobody"]).optional(),
        online: z.enum(["everyone", "same_as_last_seen", "nobody"]).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (parsed.data.last_seen === undefined && parsed.data.online === undefined) {
      return reply.code(400).send({ error: "empty_privacy" });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(parsed.data.last_seen !== undefined
          ? { lastSeenPrivacy: parsed.data.last_seen }
          : {}),
        ...(parsed.data.online !== undefined ? { onlinePrivacy: parsed.data.online } : {}),
      },
    });
    return {
      last_seen: user.lastSeenPrivacy,
      online: user.onlinePrivacy,
    };
  });

  app.post("/api/me/avatar", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "file_required" });
    }
    if (!file.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "invalid_mime" });
    }

    await mkdir(AVATAR_DIR, { recursive: true });
    const ext = extFromMime(file.mimetype);
    const filename = `${userId}-${Date.now()}.${ext}`;
    const diskPath = path.join(AVATAR_DIR, filename);
    try {
      await pipeline(file.file, createWriteStream(diskPath));
    } catch {
      await unlink(diskPath).catch(() => undefined);
      return reply.code(413).send({ error: "file_too_large" });
    }
    if (file.file.truncated) {
      await unlink(diskPath).catch(() => undefined);
      return reply.code(413).send({ error: "file_too_large" });
    }

    const avatarUrl = publicUrl(`/uploads/avatars/${filename}`);
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (existing?.avatarUrl?.includes("/uploads/avatars/")) {
      const oldName = existing.avatarUrl.split("/uploads/avatars/").pop();
      if (oldName) {
        await unlink(path.join(AVATAR_DIR, oldName)).catch(() => undefined);
      }
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });
    return toUserDto(user);
  });

  app.delete("/api/me/avatar", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (existing.avatarUrl?.includes("/uploads/avatars/")) {
      const oldName = existing.avatarUrl.split("/uploads/avatars/").pop();
      if (oldName) {
        await unlink(path.join(AVATAR_DIR, oldName)).catch(() => undefined);
      }
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null },
    });
    return toUserDto(user);
  });
}
