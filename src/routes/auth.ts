import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import {
  generateOtpCode,
  generateRefreshToken,
  hashSha256,
  toE164,
  verifyPassword,
} from "../auth/crypto.js";
import {
  bearerFromHeader,
  signAccessToken,
  signTwoStepChallenge,
  verifyAccessToken,
  verifyTwoStepChallenge,
} from "../auth/jwt.js";
import { getAppSettings, isCountryAllowed } from "../services/appConfig.js";
import { canSendSms, sendOtpSms } from "../services/sms.js";

const requestBody = z.object({
  country: z.string().min(1),
  national_number: z.string().min(4),
});

const deviceSchema = z
  .object({
    platform: z.string().optional(),
    device_name: z.string().optional(),
    app_version: z.string().optional(),
  })
  .optional();

const verifyBody = z.object({
  phone: z.string().min(5),
  code: z.string().min(4).max(8),
  device: deviceSchema,
});

const refreshBody = z.object({
  refresh: z.string().min(10),
});

const twoStepBody = z.object({
  challenge: z.string().min(10),
  pin: z.string().min(4).max(8),
  device: deviceSchema,
});

const MAX_ATTEMPTS = 5;

async function issueSession(
  userId: string,
  device?: {
    platform?: string;
    device_name?: string;
    app_version?: string;
  },
) {
  let deviceId: string | undefined;
  if (device) {
    const row = await prisma.device.create({
      data: {
        userId,
        name: device.device_name,
        platform: device.platform,
      },
    });
    deviceId = row.id;
  }

  const refresh = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashSha256(refresh),
      expiresAt: new Date(Date.now() + config.jwtRefreshTtlSec * 1000),
      deviceId: deviceId ?? null,
    },
  });

  return {
    access: signAccessToken(userId),
    refresh,
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/otp/request", async (req, reply) => {
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }

    const settings = await getAppSettings();
    if (settings.maintenance_mode) {
      return reply.code(503).send({ error: "maintenance" });
    }
    if (!(await isCountryAllowed(parsed.data.country))) {
      return reply.code(403).send({ error: "country_disabled" });
    }

    let phone: string;
    try {
      phone = toE164(parsed.data.country, parsed.data.national_number);
    } catch {
      return reply.code(400).send({ error: "invalid_phone" });
    }

    const otpGap = Number(settings.otp_gap) || config.otpResendSec;
    const otpTtl = Number(settings.otp_expiry) || config.otpTtlSec;

    const recent = await prisma.otpChallenge.findFirst({
      where: { phone, purpose: "login" },
      orderBy: { createdAt: "desc" },
    });
    if (recent) {
      const elapsedSec = (Date.now() - recent.createdAt.getTime()) / 1000;
      if (elapsedSec < otpGap && !recent.consumedAt) {
        const wait = Math.ceil(otpGap - elapsedSec);
        return reply.code(429).send({
          error: "rate_limited",
          resend_in: wait,
          phone,
          expires_in: Math.max(
            0,
            Math.ceil((recent.expiresAt.getTime() - Date.now()) / 1000),
          ),
        });
      }
    }

    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone },
      update: {},
    });
    if (user.bannedAt) {
      return reply.code(403).send({ error: "banned" });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + otpTtl * 1000);
    const smsLive = canSendSms(Boolean(settings.sms_enabled));

    await prisma.otpChallenge.create({
      data: {
        phone,
        codeHash: hashSha256(code),
        // Never store plaintext when SMS is live.
        devCode: smsLive || !config.otpDevBypass ? null : code,
        purpose: "login",
        expiresAt,
        userId: user.id,
      },
    });

    if (smsLive) {
      try {
        await sendOtpSms(phone, code);
      } catch (err) {
        req.log.error({ err, phone }, "SMS send failed");
        return reply.code(502).send({ error: "sms_failed" });
      }
    } else {
      req.log.info({ phone, code }, "dev OTP issued");
    }

    return {
      phone,
      expires_in: otpTtl,
      resend_in: otpGap,
      otp_dev_bypass: !smsLive && config.otpDevBypass,
    };
  });

  app.post("/api/auth/otp/verify", async (req, reply) => {
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const phone = parsed.data.phone.trim();
    const code = parsed.data.code.trim();

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      return reply.code(401).send({ error: "invalid_code" });
    }
    if (user.bannedAt) {
      return reply.code(403).send({ error: "banned" });
    }

    const challenge = await prisma.otpChallenge.findFirst({
      where: { phone, purpose: "login", consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
      return reply.code(401).send({ error: "invalid_or_expired" });
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
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

    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });

    const device = parsed.data.device
      ? {
          platform: parsed.data.device.platform,
          device_name: parsed.data.device.device_name,
          app_version: parsed.data.device.app_version,
        }
      : undefined;

    if (user.twoStepPinHash && user.twoStepEnabledAt) {
      return {
        two_step_required: true,
        challenge: signTwoStepChallenge(user.id, device),
      };
    }

    return issueSession(user.id, device);
  });

  app.post("/api/auth/two-step", async (req, reply) => {
    const parsed = twoStepBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    let claims;
    try {
      claims = verifyTwoStepChallenge(parsed.data.challenge);
    } catch {
      return reply.code(401).send({ error: "invalid_challenge" });
    }

    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || user.bannedAt || !user.twoStepPinHash) {
      return reply.code(401).send({ error: "invalid_challenge" });
    }

    const pinOk = await verifyPassword(parsed.data.pin.trim(), user.twoStepPinHash);
    if (!pinOk) {
      return reply.code(401).send({ error: "invalid_pin" });
    }

    const device = parsed.data.device
      ? {
          platform: parsed.data.device.platform,
          device_name: parsed.data.device.device_name,
          app_version: parsed.data.device.app_version,
        }
      : claims.device;

    return issueSession(user.id, device);
  });

  /** Thin stubs for APK reset flow — email recovery not shipped; returns 501. */
  app.post("/api/auth/two-step/reset/request", async (_req, reply) => {
    return reply.code(501).send({ error: "not_implemented" });
  });
  app.post("/api/auth/two-step/reset/confirm", async (_req, reply) => {
    return reply.code(501).send({ error: "not_implemented" });
  });

  app.post("/api/auth/refresh", async (req, reply) => {
    const parsed = refreshBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const tokenHash = hashSha256(parsed.data.refresh);
    const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (
      !existing ||
      existing.revokedAt ||
      existing.expiresAt.getTime() < Date.now()
    ) {
      return reply.code(401).send({ error: "invalid_refresh" });
    }

    const user = await prisma.user.findUnique({ where: { id: existing.userId } });
    if (!user || user.bannedAt) {
      return reply.code(403).send({ error: "forbidden" });
    }

    await prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    const refresh = generateRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashSha256(refresh),
        expiresAt: new Date(Date.now() + config.jwtRefreshTtlSec * 1000),
        deviceId: existing.deviceId,
      },
    });

    return {
      access: signAccessToken(user.id),
      refresh,
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const body = z
      .object({ refresh: z.string().optional() })
      .safeParse(req.body ?? {});
    const refresh = body.success ? body.data.refresh : undefined;

    if (refresh) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashSha256(refresh) },
        data: { revokedAt: new Date() },
      });
      return reply.code(204).send();
    }

    const token = bearerFromHeader(req.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      const claims = verifyAccessToken(token);
      await prisma.refreshToken.updateMany({
        where: { userId: claims.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return reply.code(204).send();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
}
