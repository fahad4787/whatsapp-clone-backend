import { config } from "../config.js";
import { generateOtpCode, hashSha256 } from "../auth/crypto.js";
import { prisma } from "../db.js";
import { getAppSettings } from "./appConfig.js";
import { canSendEmail, sendOtpEmail } from "./mail.js";

const MAX_ATTEMPTS = 5;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function issueEmailOtp(opts: {
  email: string;
  purpose: string;
  userId?: string | null;
  log: { info: (obj: object, msg: string) => void; error?: (obj: object, msg: string) => void };
}): Promise<{ expires_in: number; resend_in: number; otp_dev_bypass: boolean; otp_via_admin: boolean }> {
  const email = normalizeEmail(opts.email);
  const settings = await getAppSettings();
  const otpGap = Number(settings.otp_gap) || config.otpResendSec;
  const otpTtl = Number(settings.otp_expiry) || config.otpTtlSec;
  const emailLive = canSendEmail();

  const recent = await prisma.otpChallenge.findFirst({
    where: { phone: email, purpose: opts.purpose },
    orderBy: { createdAt: "desc" },
  });
  if (recent && !recent.consumedAt) {
    const elapsedSec = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (elapsedSec < otpGap) {
      const err = new Error("rate_limited") as Error & {
        statusCode: number;
        payload: Record<string, unknown>;
      };
      err.statusCode = 429;
      err.payload = {
        error: "rate_limited",
        resend_in: Math.ceil(otpGap - elapsedSec),
        expires_in: Math.max(0, Math.ceil((recent.expiresAt.getTime() - Date.now()) / 1000)),
      };
      throw err;
    }
  }

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + otpTtl * 1000);
  await prisma.otpChallenge.create({
    data: {
      phone: email,
      codeHash: hashSha256(code),
      // Never persist plaintext when SMTP will deliver the code.
      devCode: emailLive || !config.otpAdminDelivery ? null : code,
      purpose: opts.purpose,
      expiresAt,
      userId: opts.userId ?? null,
    },
  });

  if (emailLive) {
    try {
      await sendOtpEmail(email, code, opts.purpose);
      opts.log.info({ email, purpose: opts.purpose }, "email OTP sent via SMTP");
    } catch (err) {
      opts.log.error?.(
        { email, purpose: opts.purpose, err: String(err) },
        "email OTP SMTP send failed",
      );
      const e = new Error("smtp_send_failed") as Error & { statusCode: number };
      e.statusCode = 502;
      throw e;
    }
  } else {
    opts.log.info(
      { email, code, purpose: opts.purpose },
      "email OTP issued (no SMTP — code is visible to admins in the OTP log)",
    );
  }

  return {
    expires_in: otpTtl,
    resend_in: otpGap,
    otp_dev_bypass: !emailLive && config.otpDevBypass,
    otp_via_admin: !emailLive && config.otpAdminDelivery,
  };
}

export async function consumeEmailOtp(opts: {
  email: string;
  purpose: string;
  code: string;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const email = normalizeEmail(opts.email);
  const code = opts.code.trim();
  const challenge = await prisma.otpChallenge.findFirst({
    where: { phone: email, purpose: opts.purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "invalid_or_expired", status: 401 };
  }
  if (challenge.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: "too_many_attempts", status: 429 };
  }
  const emailLive = canSendEmail();
  const bypassOk = !emailLive && config.otpDevBypass && code === "000000";
  const hashOk = challenge.codeHash === hashSha256(code);
  if (!bypassOk && !hashOk) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, error: "invalid_code", status: 401 };
  }
  await prisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });
  return { ok: true };
}
