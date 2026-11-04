import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import {
  generateOtpCode,
  hashPassword,
  hashSha256,
  toE164,
  verifyPassword,
} from "../auth/crypto.js";
import { requireUser } from "../plugins/auth.js";
import { toUserDto } from "../profile.js";
import { getAppSettings, isCountryAllowed } from "../services/appConfig.js";
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
    const statusIds = Array.isArray(user.statusPrivacyIds)
      ? (user.statusPrivacyIds as string[])
      : [];
    return {
      last_seen: user.lastSeenPrivacy,
      online: user.onlinePrivacy,
      status: user.statusPrivacy,
      status_ids: statusIds,
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
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (
      parsed.data.last_seen === undefined &&
      parsed.data.online === undefined &&
      parsed.data.status === undefined &&
      parsed.data.status_ids === undefined
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

  // —— Wave 22: two-step ——
  app.get("/api/me/two-step", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    return {
      enabled: Boolean(user.twoStepPinHash && user.twoStepEnabledAt),
      enabled_at: user.twoStepEnabledAt?.toISOString() ?? null,
      email: user.twoStepEmail,
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
        devCode: smsLive || !config.otpDevBypass ? null : code,
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
}
