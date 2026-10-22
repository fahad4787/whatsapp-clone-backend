import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../plugins/auth.js";
import { publicUrl } from "../publicUrl.js";

const MEDIA_DIR = path.join(process.cwd(), "uploads", "media");
mkdirSync(MEDIA_DIR, { recursive: true });

const ALLOWED = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

function extFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

/** Flat key owned by userId prefix (no path separators). */
function safeKey(userId: string, mime: string): string {
  return `${userId}_${Date.now()}_${randomUUID().slice(0, 8)}.${extFromMime(mime)}`;
}

function assertOwnedKey(userId: string, key: string): boolean {
  return key.startsWith(`${userId}_`) && !key.includes("/") && !key.includes("..");
}

export async function mediaRoutes(app: FastifyInstance) {
  // Parse image PUT bodies as Buffer
  for (const mime of ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "application/octet-stream"]) {
    app.addContentTypeParser(mime, { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
  }

  /** S3-style contract: client PUTs bytes to upload_url, then uses public_url in a message. */
  app.post("/api/media/presign", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        content_type: z.string().min(3).max(100),
        filename: z.string().max(200).optional(),
        size: z.number().int().positive().max(10 * 1024 * 1024).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const mime = parsed.data.content_type.toLowerCase();
    if (!ALLOWED.has(mime) && !mime.startsWith("image/")) {
      return reply.code(400).send({ error: "unsupported_type" });
    }
    const key = safeKey(userId, mime);
    return {
      key,
      content_type: mime,
      upload_url: publicUrl(`/api/media/upload/${encodeURIComponent(key)}`),
      public_url: publicUrl(`/uploads/media/${key}`),
      expires_in: 900,
    };
  });

  app.put("/api/media/upload/:key", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const key = decodeURIComponent((req.params as { key: string }).key);
    if (!assertOwnedKey(userId, key)) {
      return reply.code(403).send({ error: "forbidden_key" });
    }

    const mime = String(req.headers["content-type"] ?? "image/jpeg").split(";")[0].trim().toLowerCase();
    if (!ALLOWED.has(mime) && !mime.startsWith("image/")) {
      return reply.code(400).send({ error: "unsupported_type" });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "empty_body" });
    }
    if (body.length > 10 * 1024 * 1024) {
      return reply.code(413).send({ error: "file_too_large" });
    }

    await mkdir(MEDIA_DIR, { recursive: true });
    const diskPath = path.join(MEDIA_DIR, key);
    try {
      await writeFile(diskPath, body);
    } catch {
      await unlink(diskPath).catch(() => undefined);
      return reply.code(400).send({ error: "upload_failed" });
    }

    return {
      key,
      url: publicUrl(`/uploads/media/${key}`),
      mime,
      size: body.length,
    };
  });

  /** Convenience multipart upload (same storage as PUT). */
  app.post("/api/media/upload", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "file_required" });
    }
    const mime = file.mimetype.toLowerCase();
    if (!ALLOWED.has(mime) && !mime.startsWith("image/")) {
      return reply.code(400).send({ error: "unsupported_type" });
    }

    const key = safeKey(userId, mime);
    const diskPath = path.join(MEDIA_DIR, key);
    await mkdir(MEDIA_DIR, { recursive: true });
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

    return {
      key,
      url: publicUrl(`/uploads/media/${key}`),
      mime,
      size: Number(file.file.bytesRead ?? 0),
    };
  });
}
