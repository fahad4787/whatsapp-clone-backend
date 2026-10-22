import { createHash, randomInt, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

export function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function generateRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** E.164-ish from country calling code + national digits. */
export function toE164(country: string, nationalNumber: string): string {
  const cc = country.replace(/\D/g, "");
  const nn = nationalNumber.replace(/\D/g, "");
  if (!cc || !nn) throw new Error("Invalid phone");
  return `+${cc}${nn}`;
}
