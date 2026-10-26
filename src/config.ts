import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required(
    "DATABASE_URL",
    "postgresql://aivora:aivora@localhost:5432/aivora?schema=public",
  ),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  jwtAccessSecret: required("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
  adminJwtSecret: required("ADMIN_JWT_SECRET", "dev-admin-secret-change-me"),
  jwtAccessTtlSec: Number(process.env.JWT_ACCESS_TTL_SEC ?? 900),
  jwtRefreshTtlSec: Number(process.env.JWT_REFRESH_TTL_SEC ?? 2_592_000),
  otpTtlSec: Number(process.env.OTP_TTL_SEC ?? 300),
  otpResendSec: Number(process.env.OTP_RESEND_SEC ?? 60),
  otpDevBypass: (process.env.OTP_DEV_BYPASS ?? "1") === "1",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  publicBaseUrl:
    process.env.PUBLIC_BASE_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    `http://localhost:${process.env.PORT ?? 8080}`,
  /** Stringified Firebase service account JSON (Render env). */
  fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON ?? "",
  /** Optional path to service account file for local dev. */
  fcmServiceAccountPath: process.env.FCM_SERVICE_ACCOUNT_PATH ?? "",
  /** LiveKit Cloud (or self-hosted) — Wave 16 calls. */
  livekitUrl: process.env.LIVEKIT_URL ?? "",
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
};
