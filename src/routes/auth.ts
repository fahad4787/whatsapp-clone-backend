import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import {
  generateOtpCode,
  generateRefreshToken,
  hashSha256,
  toE164,
} from "../auth/crypto.js";
import { bearerFromHeader, signAccessToken, verifyAccessToken } from "../auth/jwt.js";
import { getAppSettings, isCountryAllowed } from "../services/appConfig.js";

const requestBody = z.object({
  country: z.string().min(1),
  national_number: z.string().min(4),
});

const verifyBody = z.object({
  phone: z.string().min(5),
  code: z.string().min(4).max(8),
  device: z
    .object({
      platform: z.string().optional(),
      device_name: z.string().optional(),
      app_version: z.string().optional(),
    })
    .optional(),
});

const refreshBody = z.object({
  refresh: z.string().min(10),
});

const MAX_ATTEMPTS = 5;

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
      where: { phone },
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
    await prisma.otpChallenge.create({
      data: {
        phone,
        codeHash: hashSha256(code),
        devCode: config.otpDevBypass ? code : null,
        expiresAt,
        userId: user.id,
      },
    });

    req.log.info({ phone, code }, "dev OTP issued");

    return {
      phone,
      expires_in: otpTtl,
      resend_in: otpGap,
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
      where: { phone, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
      return reply.code(401).send({ error: "invalid_or_expired" });
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      return reply.code(429).send({ error: "too_many_attempts" });
    }

    const bypassOk = config.otpDevBypass && code === "000000";
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

    if (parsed.data.device) {
      await prisma.device.create({
        data: {
          userId: user.id,
          name: parsed.data.device.device_name,
          platform: parsed.data.device.platform,
        },
      });
    }

    const refresh = generateRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashSha256(refresh),
        expiresAt: new Date(Date.now() + config.jwtRefreshTtlSec * 1000),
      },
    });

    return {
      access: signAccessToken(user.id),
      refresh,
    };
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
