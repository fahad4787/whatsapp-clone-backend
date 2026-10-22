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

export function signAdminToken(adminId: string, role: string): string {
  return jwt.sign({ typ: "admin", role } satisfies Omit<AdminClaims, "sub">, config.adminJwtSecret, {
    subject: adminId,
    expiresIn: "8h",
  });
}

export function verifyAdminToken(token: string): AdminClaims {
  const payload = jwt.verify(token, config.adminJwtSecret) as jwt.JwtPayload;
  if (payload.typ !== "admin" || typeof payload.sub !== "string") {
    throw new Error("Invalid admin token");
  }
  return { sub: payload.sub, typ: "admin", role: String(payload.role ?? "MOD") };
}

export function bearerFromHeader(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const t = header.slice(7).trim();
  return t || null;
}
