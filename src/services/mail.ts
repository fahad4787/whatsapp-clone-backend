import nodemailer from "nodemailer";
import { config } from "../config.js";

/** True when SMTP env is complete enough to deliver mail. */
export function canSendEmail(): boolean {
  return Boolean(config.smtpHost && config.smtpFrom);
}

export async function sendOtpEmail(
  email: string,
  code: string,
  purpose: string,
): Promise<void> {
  if (!canSendEmail()) {
    throw new Error("smtp_unavailable");
  }
  const subject =
    purpose === "two_step_reset"
      ? "Aivora two-step reset code"
      : purpose === "email_login"
        ? "Aivora sign-in code"
        : "Aivora verification code";
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth:
      config.smtpUser || config.smtpPass
        ? { user: config.smtpUser, pass: config.smtpPass }
        : undefined,
  });
  await transporter.sendMail({
    from: config.smtpFrom,
    to: email,
    subject,
    text: `Your Aivora code is ${code}. It expires in a few minutes. If you did not request this, ignore this email.`,
  });
}
