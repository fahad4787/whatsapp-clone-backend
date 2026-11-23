import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { mirrorUpload } from "../fileStore.js";
import {
  generateOtpCode,
  hashPassword,
  hashSha256,
  toE164,
  verifyPassword,
} from "../auth/crypto.js";
import {
  buildChatExport,
  createAccountBackupZipStream,
  safeExportBasename,
} from "../exportChat.js";
import { requireUser } from "../plugins/auth.js";
import { toUserDto } from "../profile.js";
import { broadcastProfileUpdate } from "../presenceBroadcast.js";
import { getAppSettings, isCountryAllowed } from "../services/appConfig.js";
import {
  consumeEmailOtp,
  issueEmailOtp,
  normalizeEmail,
} from "../services/emailOtp.js";
import { canSendSms, sendOtpSms } from "../services/sms.js";

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

  /** Wave 32 — account information report (no chat message bodies). */
  app.get("/api/me/data", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });

    const [devices, memberships, blocksOut, blocksIn, reportsFiled] = await Promise.all([
      prisma.device.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: {
          id: true,
          name: true,
          platform: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.conversationMember.findMany({
        where: { userId },
        take: 200,
        include: {
          conversation: { select: { id: true, type: true, title: true, updatedAt: true } },
        },
      }),
      prisma.block.count({ where: { blockerId: userId } }),
      prisma.block.count({ where: { blockedId: userId } }),
      prisma.report.count({ where: { reporterId: userId } }),
    ]);

    const report = {
      format: "aivora-account-info-v1",
      generated_at: new Date().toISOString(),
      note: "Chat message bodies are not included. Use Chat backup / Export chat for conversations.",
      profile: {
        id: user.id,
        phone: user.phone,
        display_name: user.displayName,
        about: user.about,
        avatar_url: user.avatarUrl,
        created_at: user.createdAt.toISOString(),
        last_seen_at: user.lastSeenAt?.toISOString() ?? null,
      },
      recovery_email: {
        email: user.twoStepEmail,
        verified: Boolean(user.twoStepEmail && user.emailVerifiedAt),
        verified_at: user.emailVerifiedAt?.toISOString() ?? null,
      },
      two_step: {
        enabled: Boolean(user.twoStepPinHash && user.twoStepEnabledAt),
        enabled_at: user.twoStepEnabledAt?.toISOString() ?? null,
      },
      chat_lock: {
        enabled: Boolean(user.chatLockPinHash && user.chatLockEnabledAt),
        hide_folder: user.chatLockHideFolder,
      },
      privacy: {
        last_seen: user.lastSeenPrivacy,
        online: user.onlinePrivacy,
        status: user.statusPrivacy,
        profile_photo: user.profilePhotoPrivacy,
        about: user.aboutPrivacy,
        groups: user.groupsPrivacy,
        silence_unknown_callers: user.silenceUnknownCallers,
        links: user.linksPrivacy,
        read_receipts: user.readReceipts,
      },
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        created_at: d.createdAt.toISOString(),
        last_active_at: d.updatedAt.toISOString(),
      })),
      conversations: memberships.map((m) => ({
        id: m.conversation.id,
        type: m.conversation.type,
        title: m.conversation.title,
        role: m.role,
        muted: Boolean(m.mutedUntil && m.mutedUntil.getTime() > Date.now()),
        archived: m.archived,
        updated_at: m.conversation.updatedAt.toISOString(),
      })),
      media_prefs: {
        mobile: user.autoDlMobile,
        wifi: user.autoDlWifi,
        roaming: user.autoDlRoaming,
        less_data_calls: user.lessDataCalls,
        photo_upload_quality: user.photoUploadQuality,
      },
      stats: {
        conversation_count: memberships.length,
        device_count: devices.length,
        blocks_outgoing: blocksOut,
        blocks_incoming: blocksIn,
        reports_filed: reportsFiled,
      },
    };

    const body = `${JSON.stringify(report, null, 2)}\n`;
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="Aivora Account Info ${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return reply.send(body);
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
    void broadcastProfileUpdate(userId);
    return toUserDto(user);
  });

  app.get("/api/me/privacy", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    const statusIds = Array.isArray(user.statusPrivacyIds)
      ? (user.statusPrivacyIds as string[])
      : [];
    return {
      last_seen: user.lastSeenPrivacy,
      online: user.onlinePrivacy,
      status: user.statusPrivacy,
      status_ids: statusIds,
      profile_photo: user.profilePhotoPrivacy,
      about: user.aboutPrivacy,
      groups: user.groupsPrivacy,
      silence_unknown_callers: user.silenceUnknownCallers,
      links: user.linksPrivacy,
      read_receipts: user.readReceipts,
    };
  });

  app.put("/api/me/privacy", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        last_seen: z.enum(["everyone", "contacts", "nobody"]).optional(),
        online: z.enum(["everyone", "same_as_last_seen", "nobody"]).optional(),
        status: z
          .enum(["everyone", "contacts", "contacts_except", "only_share"])
          .optional(),
        status_ids: z.array(z.string().min(1)).max(200).optional(),
        profile_photo: z.enum(["everyone", "contacts", "nobody"]).optional(),
        about: z.enum(["everyone", "contacts", "nobody"]).optional(),
        groups: z.enum(["everyone", "contacts", "contacts_except"]).optional(),
        silence_unknown_callers: z.boolean().optional(),
        links: z.enum(["everyone", "contacts", "nobody"]).optional(),
        read_receipts: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (
      parsed.data.last_seen === undefined &&
      parsed.data.online === undefined &&
      parsed.data.status === undefined &&
      parsed.data.status_ids === undefined &&
      parsed.data.profile_photo === undefined &&
      parsed.data.about === undefined &&
      parsed.data.groups === undefined &&
      parsed.data.silence_unknown_callers === undefined &&
      parsed.data.links === undefined &&
      parsed.data.read_receipts === undefined
    ) {
      return reply.code(400).send({ error: "empty_privacy" });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(parsed.data.last_seen !== undefined
          ? { lastSeenPrivacy: parsed.data.last_seen }
          : {}),
        ...(parsed.data.online !== undefined ? { onlinePrivacy: parsed.data.online } : {}),
        ...(parsed.data.status !== undefined ? { statusPrivacy: parsed.data.status } : {}),
        ...(parsed.data.status_ids !== undefined
          ? { statusPrivacyIds: parsed.data.status_ids }
          : {}),
        ...(parsed.data.profile_photo !== undefined
          ? { profilePhotoPrivacy: parsed.data.profile_photo }
          : {}),
        ...(parsed.data.about !== undefined ? { aboutPrivacy: parsed.data.about } : {}),
        ...(parsed.data.groups !== undefined ? { groupsPrivacy: parsed.data.groups } : {}),
        ...(parsed.data.silence_unknown_callers !== undefined
          ? { silenceUnknownCallers: parsed.data.silence_unknown_callers }
          : {}),
        ...(parsed.data.links !== undefined ? { linksPrivacy: parsed.data.links } : {}),
        ...(parsed.data.read_receipts !== undefined
          ? { readReceipts: parsed.data.read_receipts }
          : {}),
      },
    });
    const statusIds = Array.isArray(user.statusPrivacyIds)
      ? (user.statusPrivacyIds as string[])
      : [];
    return {
      last_seen: user.lastSeenPrivacy,
      online: user.onlinePrivacy,
      status: user.statusPrivacy,
      status_ids: statusIds,
      profile_photo: user.profilePhotoPrivacy,
      about: user.aboutPrivacy,
      groups: user.groupsPrivacy,
      silence_unknown_callers: user.silenceUnknownCallers,
      links: user.linksPrivacy,
      read_receipts: user.readReceipts,
    };
  });

  const mediaPref = z.enum(["photos", "photos_audio", "all", "none"]);
  const qualityPref = z.enum(["auto", "high", "data_saver"]);

  function autoDownloadDto(user: {
    autoDlMobile: string;
    autoDlWifi: string;
    autoDlRoaming: string;
    lessDataCalls: boolean;
    photoUploadQuality: string;
  }) {
    return {
      mobile: user.autoDlMobile,
      wifi: user.autoDlWifi,
      roaming: user.autoDlRoaming,
      less_data_calls: user.lessDataCalls,
      photo_upload_quality: user.photoUploadQuality,
    };
  }

  /** Wave 34 — media auto-download / data prefs. */
  app.get("/api/me/auto-download", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    return autoDownloadDto(user);
  });

  app.patch("/api/me/auto-download", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        mobile: mediaPref.optional(),
        wifi: mediaPref.optional(),
        roaming: mediaPref.optional(),
        less_data_calls: z.boolean().optional(),
        photo_upload_quality: qualityPref.optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: "empty_patch" });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(parsed.data.mobile !== undefined ? { autoDlMobile: parsed.data.mobile } : {}),
        ...(parsed.data.wifi !== undefined ? { autoDlWifi: parsed.data.wifi } : {}),
        ...(parsed.data.roaming !== undefined ? { autoDlRoaming: parsed.data.roaming } : {}),
        ...(parsed.data.less_data_calls !== undefined
          ? { lessDataCalls: parsed.data.less_data_calls }
          : {}),
        ...(parsed.data.photo_upload_quality !== undefined
          ? { photoUploadQuality: parsed.data.photo_upload_quality }
          : {}),
      },
    });
    return autoDownloadDto(user);
  });

  const disappearSecs = z.union([
    z.literal(0),
    z.literal(86_400),
    z.literal(604_800),
    z.literal(7_776_000),
  ]);

  function prefsDto(user: {
    defaultDisappearingSeconds: number;
    protectIpInCalls: boolean;
    disableLinkPreviews: boolean;
    blockUnknownMessages: boolean;
  }) {
    return {
      default_disappearing_seconds: user.defaultDisappearingSeconds,
      protect_ip_calls: user.protectIpInCalls,
      disable_link_previews: user.disableLinkPreviews,
      block_unknown: user.blockUnknownMessages,
    };
  }

  /** Wave 41 — default timer + advanced privacy. */
  app.get("/api/me/preferences", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    return prefsDto(user);
  });

  app.patch("/api/me/preferences", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        default_disappearing_seconds: disappearSecs.optional(),
        protect_ip_calls: z.boolean().optional(),
        disable_link_previews: z.boolean().optional(),
        block_unknown: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: "empty_patch" });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(parsed.data.default_disappearing_seconds !== undefined
          ? { defaultDisappearingSeconds: parsed.data.default_disappearing_seconds }
          : {}),
        ...(parsed.data.protect_ip_calls !== undefined
          ? { protectIpInCalls: parsed.data.protect_ip_calls }
          : {}),
        ...(parsed.data.disable_link_previews !== undefined
          ? { disableLinkPreviews: parsed.data.disable_link_previews }
          : {}),
        ...(parsed.data.block_unknown !== undefined
          ? { blockUnknownMessages: parsed.data.block_unknown }
          : {}),
      },
    });
    return prefsDto(user);
  });

  /** Approximate media bytes used by this user's conversations (Wave 24). */
  app.get("/api/me/storage", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const memberships = await prisma.conversationMember.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    const convIds = memberships.map((m) => m.conversationId);
    if (convIds.length === 0) {
      return {
        used_bytes: 0,
        media_bytes: 0,
        chats: [] as { conversation_id: string; title: string | null; bytes: number }[],
      };
    }

    const messages = await prisma.message.findMany({
      where: {
        conversationId: { in: convIds },
        deletedForEveryoneAt: null,
        OR: [
          { type: "IMAGE" },
          { type: "VIDEO" },
          { type: "AUDIO" },
          { type: "FILE" },
        ],
      },
      select: {
        conversationId: true,
        attachment: true,
      },
    });

    const byConv = new Map<string, number>();
    let mediaBytes = 0;
    for (const m of messages) {
      const att = m.attachment as { size?: number } | null;
      const size = typeof att?.size === "number" && att.size > 0 ? att.size : 0;
      mediaBytes += size;
      byConv.set(m.conversationId, (byConv.get(m.conversationId) ?? 0) + size);
    }

    const convs = await prisma.conversation.findMany({
      where: { id: { in: [...byConv.keys()] } },
      select: { id: true, title: true, type: true },
    });
    const titleById = new Map(convs.map((c) => [c.id, c.title]));

    const chats = [...byConv.entries()]
      .map(([conversation_id, bytes]) => ({
        id: conversation_id,
        conversation_id,
        title: titleById.get(conversation_id) ?? null,
        count: 0,
        bytes,
      }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 50);

    return {
      used_bytes: mediaBytes,
      media_bytes: mediaBytes,
      chats,
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

    await mirrorUpload(`avatars/${filename}`, diskPath, file.mimetype);
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
    void broadcastProfileUpdate(userId);
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
    void broadcastProfileUpdate(userId);
    return toUserDto(user);
  });

  // —— Wave 30: account / recovery email ——
  app.get("/api/me/email", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    return {
      email: user.twoStepEmail,
      verified: Boolean(user.twoStepEmail && user.emailVerifiedAt),
      verified_at: user.emailVerifiedAt?.toISOString() ?? null,
    };
  });

  app.post("/api/me/email/request", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({ email: z.string().email() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const email = normalizeEmail(parsed.data.email);
    const taken = await prisma.user.findFirst({
      where: {
        twoStepEmail: email,
        emailVerifiedAt: { not: null },
        NOT: { id: userId },
      },
    });
    if (taken) {
      return reply.code(409).send({ error: "email_in_use" });
    }
    try {
      const issued = await issueEmailOtp({
        email,
        purpose: "email_verify",
        userId,
        log: req.log,
      });
      return { email, ...issued };
    } catch (err) {
      const e = err as Error & { statusCode?: number; payload?: Record<string, unknown> };
      if (e.statusCode === 429 && e.payload) {
        return reply.code(429).send(e.payload);
      }
      if (e.statusCode === 502) {
        return reply.code(502).send({ error: "smtp_send_failed" });
      }
      throw err;
    }
  });

  app.post("/api/me/email/verify", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        email: z.string().email(),
        code: z.string().min(4).max(8),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const email = normalizeEmail(parsed.data.email);
    const result = await consumeEmailOtp({
      email,
      purpose: "email_verify",
      code: parsed.data.code,
    });
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }
    const taken = await prisma.user.findFirst({
      where: {
        twoStepEmail: email,
        emailVerifiedAt: { not: null },
        NOT: { id: userId },
      },
    });
    if (taken) {
      return reply.code(409).send({ error: "email_in_use" });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        twoStepEmail: email,
        emailVerifiedAt: new Date(),
      },
    });
    return {
      email: user.twoStepEmail,
      verified: true,
      verified_at: user.emailVerifiedAt?.toISOString() ?? null,
    };
  });

  app.delete("/api/me/email", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    await prisma.user.update({
      where: { id: userId },
      data: { twoStepEmail: null, emailVerifiedAt: null },
    });
    return { email: null, verified: false, verified_at: null };
  });

  // —— Wave 22: two-step ——
  app.get("/api/me/two-step", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    return {
      enabled: Boolean(user.twoStepPinHash && user.twoStepEnabledAt),
      enabled_at: user.twoStepEnabledAt?.toISOString() ?? null,
      email: user.twoStepEmail,
      email_verified: Boolean(user.twoStepEmail && user.emailVerifiedAt),
    };
  });

  app.patch("/api/me/two-step", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        pin: z.string().regex(/^\d{6}$/),
        email: z.string().email().optional().nullable(),
        current: z.string().regex(/^\d{6}$/).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });

    if (user.twoStepPinHash) {
      if (!parsed.data.current) {
        return reply.code(400).send({ error: "current_pin_required" });
      }
      const ok = await verifyPassword(parsed.data.current, user.twoStepPinHash);
      if (!ok) return reply.code(401).send({ error: "invalid_pin" });
    }

    const pinHash = await hashPassword(parsed.data.pin);
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        twoStepPinHash: pinHash,
        twoStepEnabledAt: user.twoStepEnabledAt ?? new Date(),
        ...(parsed.data.email !== undefined
          ? { twoStepEmail: parsed.data.email }
          : {}),
      },
    });
    return {
      enabled: true,
      enabled_at: updated.twoStepEnabledAt?.toISOString() ?? null,
      email: updated.twoStepEmail,
    };
  });

  app.post("/api/me/two-step/off", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({ pin: z.string().regex(/^\d{6}$/) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.twoStepPinHash) {
      return { enabled: false, enabled_at: null, email: null };
    }
    const ok = await verifyPassword(parsed.data.pin, user.twoStepPinHash);
    if (!ok) return reply.code(401).send({ error: "invalid_pin" });

    await prisma.user.update({
      where: { id: userId },
      data: {
        twoStepPinHash: null,
        twoStepEnabledAt: null,
      },
    });
    return { enabled: false, enabled_at: null, email: user.twoStepEmail };
  });

  // —— Wave 25: chat lock ——
  app.get("/api/me/chat-lock", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    const lockedCount = await prisma.conversationMember.count({
      where: { userId, lockedAt: { not: null } },
    });
    return {
      enabled: Boolean(user.chatLockPinHash && user.chatLockEnabledAt),
      enabled_at: user.chatLockEnabledAt?.toISOString() ?? null,
      hide_folder: user.chatLockHideFolder,
      locked_count: lockedCount,
    };
  });

  app.patch("/api/me/chat-lock", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        pin: z.string().regex(/^\d{4,8}$/).optional(),
        current: z.string().regex(/^\d{4,8}$/).optional(),
        hide_folder: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });

    if (parsed.data.pin) {
      if (user.chatLockPinHash) {
        if (!parsed.data.current) {
          return reply.code(400).send({ error: "current_pin_required" });
        }
        const ok = await verifyPassword(parsed.data.current, user.chatLockPinHash);
        if (!ok) return reply.code(401).send({ error: "invalid_pin" });
      }
      const pinHash = await hashPassword(parsed.data.pin);
      await prisma.user.update({
        where: { id: userId },
        data: {
          chatLockPinHash: pinHash,
          chatLockEnabledAt: user.chatLockEnabledAt ?? new Date(),
          ...(parsed.data.hide_folder !== undefined
            ? { chatLockHideFolder: parsed.data.hide_folder }
            : {}),
        },
      });
    } else if (parsed.data.hide_folder !== undefined) {
      if (!user.chatLockPinHash) {
        return reply.code(400).send({ error: "chat_lock_pin_required" });
      }
      await prisma.user.update({
        where: { id: userId },
        data: { chatLockHideFolder: parsed.data.hide_folder },
      });
    } else {
      return reply.code(400).send({ error: "empty_body" });
    }

    const updated = await prisma.user.findUnique({ where: { id: userId } });
    const lockedCount = await prisma.conversationMember.count({
      where: { userId, lockedAt: { not: null } },
    });
    return {
      enabled: Boolean(updated?.chatLockPinHash && updated.chatLockEnabledAt),
      enabled_at: updated?.chatLockEnabledAt?.toISOString() ?? null,
      hide_folder: updated?.chatLockHideFolder ?? false,
      locked_count: lockedCount,
    };
  });

  app.post("/api/me/chat-lock/unlock", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({ pin: z.string().regex(/^\d{4,8}$/) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.chatLockPinHash) {
      return reply.code(400).send({ error: "chat_lock_not_enabled" });
    }
    const ok = await verifyPassword(parsed.data.pin, user.chatLockPinHash);
    if (!ok) return reply.code(401).send({ error: "invalid_pin" });
    return { ok: true };
  });

  // —— Wave 22: delete account ——
  app.post("/api/me/delete/request", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    return { phone: user.phone, confirm_required: true };
  });

  app.post("/api/me/delete", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        phone: z.string().min(5).optional(),
        national_number: z.string().min(4).optional(),
        country: z.string().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });

    let confirmPhone = parsed.data.phone?.trim();
    if (!confirmPhone && parsed.data.national_number) {
      try {
        confirmPhone = toE164(
          parsed.data.country ?? "92",
          parsed.data.national_number,
        );
      } catch {
        return reply.code(400).send({ error: "invalid_phone" });
      }
    }
    if (!confirmPhone || confirmPhone !== user.phone) {
      return reply.code(400).send({ error: "phone_mismatch" });
    }

    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.user.delete({ where: { id: userId } });
    return reply.code(204).send();
  });

  // —— Wave 22: change number ——
  app.post("/api/me/change-number/request", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        country: z.string().min(1),
        national_number: z.string().min(4),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const settings = await getAppSettings();
    if (!(await isCountryAllowed(parsed.data.country))) {
      return reply.code(403).send({ error: "country_disabled" });
    }

    let phone: string;
    try {
      phone = toE164(parsed.data.country, parsed.data.national_number);
    } catch {
      return reply.code(400).send({ error: "invalid_phone" });
    }

    const me = await prisma.user.findUnique({ where: { id: userId } });
    if (!me) return reply.code(404).send({ error: "not_found" });
    if (me.phone === phone) {
      return reply.code(400).send({ error: "same_phone" });
    }
    const taken = await prisma.user.findUnique({ where: { phone } });
    if (taken) {
      return reply.code(409).send({ error: "phone_taken" });
    }

    const otpGap = Number(settings.otp_gap) || config.otpResendSec;
    const otpTtl = Number(settings.otp_expiry) || config.otpTtlSec;
    const recent = await prisma.otpChallenge.findFirst({
      where: { phone, purpose: "change_number", userId },
      orderBy: { createdAt: "desc" },
    });
    if (recent && !recent.consumedAt) {
      const elapsedSec = (Date.now() - recent.createdAt.getTime()) / 1000;
      if (elapsedSec < otpGap) {
        return reply.code(429).send({
          error: "rate_limited",
          resend_in: Math.ceil(otpGap - elapsedSec),
          phone,
        });
      }
    }

    const code = generateOtpCode();
    const smsLive = canSendSms(Boolean(settings.sms_enabled));
    await prisma.otpChallenge.create({
      data: {
        phone,
        codeHash: hashSha256(code),
        devCode: smsLive || !config.otpAdminDelivery ? null : code,
        purpose: "change_number",
        expiresAt: new Date(Date.now() + otpTtl * 1000),
        userId,
      },
    });

    if (smsLive) {
      try {
        await sendOtpSms(phone, code);
      } catch (err) {
        req.log.error({ err, phone }, "change-number SMS failed");
        return reply.code(502).send({ error: "sms_failed" });
      }
    } else {
      req.log.info({ phone, code, purpose: "change_number" }, "dev OTP issued");
    }

    return {
      phone,
      expires_in: otpTtl,
      resend_in: otpGap,
      otp_dev_bypass: !smsLive && config.otpDevBypass,
      otp_via_admin: !smsLive && config.otpAdminDelivery,
    };
  });

  app.post("/api/me/change-number/verify", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        phone: z.string().min(5),
        code: z.string().min(4).max(8),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const phone = parsed.data.phone.trim();
    const code = parsed.data.code.trim();
    const challenge = await prisma.otpChallenge.findFirst({
      where: { phone, purpose: "change_number", userId, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
      return reply.code(401).send({ error: "invalid_or_expired" });
    }
    if (challenge.attempts >= 5) {
      return reply.code(429).send({ error: "too_many_attempts" });
    }

    const settings = await getAppSettings();
    const smsLive = canSendSms(Boolean(settings.sms_enabled));
    const bypassOk = !smsLive && config.otpDevBypass && code === "000000";
    const hashOk = challenge.codeHash === hashSha256(code);
    if (!bypassOk && !hashOk) {
      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      return reply.code(401).send({ error: "invalid_code" });
    }

    const taken = await prisma.user.findUnique({ where: { phone } });
    if (taken && taken.id !== userId) {
      return reply.code(409).send({ error: "phone_taken" });
    }

    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });

    const user = await prisma.user.update({
      where: { id: userId },
      data: { phone },
    });
    return toUserDto(user);
  });

  // —— Wave 26: live locations ——
  app.get("/api/me/live-locations", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const rows = await prisma.message.findMany({
      where: {
        senderId: userId,
        type: "LOCATION",
        deletedForEveryoneAt: null,
      },
      orderBy: { updatedAt: "desc" },
      take: 40,
    });
    const items = [];
    for (const m of rows) {
      const p = (m.payload ?? {}) as Record<string, unknown>;
      if (!p.live || p.ended) continue;
      const expiresAt = p.expires_at ? Date.parse(String(p.expires_at)) : NaN;
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) continue;
      items.push({
        message_id: m.id,
        conversation_id: m.conversationId,
        started_at: p.started_at ? String(p.started_at) : m.createdAt.toISOString(),
        expires_at: p.expires_at ? String(p.expires_at) : null,
        updated_at: p.updated_at ? String(p.updated_at) : m.updatedAt.toISOString(),
        device_id: null,
      });
    }
    return { items };
  });

  app.post("/api/me/live-locations/stop", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        message_id: z.string().min(1).optional().nullable(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const where = {
      senderId: userId,
      type: "LOCATION" as const,
      deletedForEveryoneAt: null,
      ...(parsed.data.message_id ? { id: parsed.data.message_id } : {}),
    };
    const rows = await prisma.message.findMany({ where, take: 40 });
    let stopped = 0;
    for (const m of rows) {
      const p = (m.payload ?? {}) as Record<string, unknown>;
      if (!p.live || p.ended) continue;
      await prisma.message.update({
        where: { id: m.id },
        data: {
          payload: { ...p, ended: true, updated_at: new Date().toISOString() },
          text: "Live location ended",
        },
      });
      stopped += 1;
    }
    return { ok: true, stopped };
  });

  /** Wave 29 — download all chats as one zip (share / save locally). */
  app.get("/api/me/backup", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const q = req.query as { media?: string };
    const includeMedia = q.media === "1" || q.media === "true";

    const memberships = await prisma.conversationMember.findMany({
      where: { userId },
      take: 100,
      include: {
        conversation: {
          include: { members: { include: { user: true } } },
        },
      },
      orderBy: { conversation: { updatedAt: "desc" } },
    });

    const chats: { folder: string; built: ReturnType<typeof buildChatExport> }[] = [];
    for (const mem of memberships) {
      const conv = mem.conversation;
      const messages = await prisma.message.findMany({
        where: {
          conversationId: conv.id,
          hides: { none: { userId } },
          ...(mem.clearedAt ? { createdAt: { gt: mem.clearedAt } } : {}),
        },
        orderBy: { createdAt: "asc" },
        take: 20_000,
        select: {
          id: true,
          type: true,
          text: true,
          attachment: true,
          payload: true,
          deletedForEveryoneAt: true,
          expiresAt: true,
          viewOnce: true,
          createdAt: true,
          senderId: true,
        },
      });
      const nameById = new Map(
        conv.members.map((m) => [
          m.userId,
          m.user.displayName?.trim() || m.user.phone || m.userId,
        ]),
      );
      const peer =
        conv.type === "DIRECT"
          ? conv.members.find((m) => m.userId !== userId)?.user
          : null;
      const title =
        conv.type === "GROUP"
          ? conv.title?.trim() || "Group"
          : peer?.displayName?.trim() || peer?.phone || "Chat";
      const built = buildChatExport({
        title,
        messages: messages.map((m) => ({ ...m, type: String(m.type) })),
        senderName: (sid) => nameById.get(sid) || sid,
        includeMedia,
      });
      chats.push({ folder: safeExportBasename(title), built });
    }

    const meta = {
      format: "aivora-backup-v1",
      exported_at: new Date().toISOString(),
      include_media: includeMedia,
      chat_count: chats.length,
      note: "Portable archive of your chats. Signing in on a new device restores live data from the server.",
    };

    reply.header("Content-Type", "application/zip");
    reply.header(
      "Content-Disposition",
      `attachment; filename="Aivora Backup ${new Date().toISOString().slice(0, 10)}.zip"`,
    );
    return reply.send(createAccountBackupZipStream(chats, meta));
  });
}
