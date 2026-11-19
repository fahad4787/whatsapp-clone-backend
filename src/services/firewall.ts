import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { ensureAppConfigSeeded } from "./appConfig.js";

function asObject(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

/** Parse IPv4 like 1.2.3.4 → 32-bit int. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0]! << 24) >>> 0) + (nums[1]! << 16) + (nums[2]! << 8) + nums[3]!;
}

function cidrMatch(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (!base) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt == null || baseInt == null) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function normalizeClientIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1") ip = "127.0.0.1";
  return ipv4ToInt(ip) != null ? ip : null;
}

export async function getAdminIpAllowlist(): Promise<string[]> {
  await ensureAppConfigSeeded();
  const row = await prisma.appConfig.findUnique({ where: { id: "default" } });
  const o = asObject(row?.data);
  const list = o.admin_ip_allowlist;
  if (!Array.isArray(list)) return [];
  return list.map(String).map((s) => s.trim()).filter(Boolean);
}

export async function setAdminIpAllowlist(entries: string[]): Promise<string[]> {
  await ensureAppConfigSeeded();
  const cleaned = entries.map((s) => s.trim()).filter(Boolean);
  const row = await prisma.appConfig.findUnique({ where: { id: "default" } });
  const data = { ...asObject(row?.data), admin_ip_allowlist: cleaned };
  await prisma.appConfig.update({
    where: { id: "default" },
    data: { data: data as Prisma.InputJsonValue },
  });
  return cleaned;
}

/** Empty allowlist = allow all. */
export async function isAdminIpAllowed(clientIp: string | undefined | null): Promise<boolean> {
  const allow = await getAdminIpAllowlist();
  if (allow.length === 0) return true;
  const ip = normalizeClientIp(clientIp);
  if (!ip) return false;
  return allow.some((cidr) => cidrMatch(ip, cidr.includes("/") ? cidr : `${cidr}/32`));
}
