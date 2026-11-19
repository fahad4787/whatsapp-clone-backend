import jwt from "jsonwebtoken";
import { config } from "../config.js";

export type AccessClaims = {
  sub: string;
  typ: "access";
};

export type AdminClaims = {
  sub: string;
  typ: "admin";
  role: string;
};

export type TwoStepChallengeClaims = {
  sub: string;
  typ: "two_step";
  device?: {
    platform?: string;
    device_name?: string;
    app_version?: string;
  };
};

export function signAccessToken(userId: string): string {
  return jwt.sign({ typ: "access" } satisfies Omit<AccessClaims, "sub">, config.jwtAccessSecret, {
    subject: userId,
    expiresIn: config.jwtAccessTtlSec,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, config.jwtAccessSecret) as jwt.JwtPayload;
  if (payload.typ !== "access" || typeof payload.sub !== "string") {
    throw new Error("Invalid access token");
  }
  return { sub: payload.sub, typ: "access" };
}

/** Short-lived challenge after OTP when two-step PIN is enabled. */
export function signTwoStepChallenge(
  userId: string,
  device?: TwoStepChallengeClaims["device"],
): string {
  return jwt.sign(
    { typ: "two_step", device } satisfies Omit<TwoStepChallengeClaims, "sub">,
    config.jwtAccessSecret,
    { subject: userId, expiresIn: 600 },
  );
}

export function verifyTwoStepChallenge(token: string): TwoStepChallengeClaims {
  const payload = jwt.verify(token, config.jwtAccessSecret) as jwt.JwtPayload;
  if (payload.typ !== "two_step" || typeof payload.sub !== "string") {
    throw new Error("Invalid two-step challenge");
  }
  const device =
    payload.device && typeof payload.device === "object"
      ? (payload.device as TwoStepChallengeClaims["device"])
      : undefined;
  return { sub: payload.sub, typ: "two_step", device };
}

export function signAdminToken(adminId: string, role: string, expiresInHours = 8): string {
  const hours = Math.min(168, Math.max(1, Math.floor(expiresInHours)));
  return jwt.sign({ typ: "admin", role } satisfies Omit<AdminClaims, "sub">, config.adminJwtSecret, {
    subject: adminId,
    expiresIn: `${hours}h`,
  });
}

export function verifyAdminToken(token: string): AdminClaims {
  const payload = jwt.verify(token, config.adminJwtSecret) as jwt.JwtPayload;
  if (payload.typ !== "admin" || typeof payload.sub !== "string") {
    throw new Error("Invalid admin token");
  }
  return { sub: payload.sub, typ: "admin", role: String(payload.role ?? "MOD") };
}

/** Short-lived ticket after password, before TOTP (Wave 58). */
export function signAdminTotpTicket(
  adminId: string,
  role: string,
  purpose: "login" | "enroll",
): string {
  return jwt.sign(
    { typ: "admin_totp", role, purpose },
    config.adminJwtSecret,
    { subject: adminId, expiresIn: purpose === "enroll" ? "15m" : "5m" },
  );
}

export function verifyAdminTotpTicket(token: string): {
  sub: string;
  role: string;
  purpose: "login" | "enroll";
} {
  const payload = jwt.verify(token, config.adminJwtSecret) as jwt.JwtPayload;
  if (payload.typ !== "admin_totp" || typeof payload.sub !== "string") {
    throw new Error("Invalid admin TOTP ticket");
  }
  const purpose = payload.purpose === "enroll" ? "enroll" : "login";
  return { sub: payload.sub, role: String(payload.role ?? "MOD"), purpose };
}

export function bearerFromHeader(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const t = header.slice(7).trim();
  return t || null;
}
