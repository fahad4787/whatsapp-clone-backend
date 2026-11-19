import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { ensureAppConfigSeeded } from "./appConfig.js";

function asObject(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

export type AdminSecurity = {
  require_2fa: boolean;
  lock_after_fail: boolean;
  session_hours: number;
  max_fail_attempts: number;
  lock_minutes: number;
};

export const DEFAULT_ADMIN_SECURITY: AdminSecurity = {
  require_2fa: false,
  lock_after_fail: true,
  session_hours: 8,
  max_fail_attempts: 5,
  lock_minutes: 15,
};

type FailState = { count: number; lockedUntil: number | null };
const failByEmail = new Map<string, FailState>();

export async function getAdminSecurity(): Promise<AdminSecurity> {
  await ensureAppConfigSeeded();
  const row = await prisma.appConfig.findUnique({ where: { id: "default" } });
  const o = asObject(row?.data);
  const sessionRaw = Number(o.admin_session_hours);
  const maxFailRaw = Number(o.admin_max_fail_attempts);
  const lockMinRaw = Number(o.admin_lock_minutes);
  return {
    require_2fa: Boolean(o.admin_require_2fa ?? DEFAULT_ADMIN_SECURITY.require_2fa),
    lock_after_fail: Boolean(
      o.admin_lock_after_fail ?? DEFAULT_ADMIN_SECURITY.lock_after_fail,
    ),
    session_hours:
      Number.isFinite(sessionRaw) && sessionRaw >= 1 && sessionRaw <= 168
        ? Math.floor(sessionRaw)
        : DEFAULT_ADMIN_SECURITY.session_hours,
    max_fail_attempts:
      Number.isFinite(maxFailRaw) && maxFailRaw >= 3 && maxFailRaw <= 20
        ? Math.floor(maxFailRaw)
        : DEFAULT_ADMIN_SECURITY.max_fail_attempts,
    lock_minutes:
      Number.isFinite(lockMinRaw) && lockMinRaw >= 1 && lockMinRaw <= 1440
        ? Math.floor(lockMinRaw)
        : DEFAULT_ADMIN_SECURITY.lock_minutes,
  };
}

export async function setAdminSecurity(
  patch: Partial<AdminSecurity>,
): Promise<AdminSecurity> {
  const current = await getAdminSecurity();
  const next: AdminSecurity = {
    require_2fa: patch.require_2fa ?? current.require_2fa,
    lock_after_fail: patch.lock_after_fail ?? current.lock_after_fail,
    session_hours: patch.session_hours ?? current.session_hours,
    max_fail_attempts: patch.max_fail_attempts ?? current.max_fail_attempts,
    lock_minutes: patch.lock_minutes ?? current.lock_minutes,
  };
  await ensureAppConfigSeeded();
  const row = await prisma.appConfig.findUnique({ where: { id: "default" } });
  const data = {
    ...asObject(row?.data),
    admin_require_2fa: next.require_2fa,
    admin_lock_after_fail: next.lock_after_fail,
    admin_session_hours: next.session_hours,
    admin_max_fail_attempts: next.max_fail_attempts,
    admin_lock_minutes: next.lock_minutes,
  };
  await prisma.appConfig.update({
    where: { id: "default" },
    data: { data: data as Prisma.InputJsonValue },
  });
  return next;
}

export async function isAdminLoginLocked(email: string): Promise<boolean> {
  const sec = await getAdminSecurity();
  if (!sec.lock_after_fail) return false;
  const key = email.toLowerCase();
  const st = failByEmail.get(key);
  if (!st?.lockedUntil) return false;
  if (Date.now() >= st.lockedUntil) {
    failByEmail.delete(key);
    return false;
  }
  return true;
}

export async function recordAdminLoginFailure(email: string): Promise<void> {
  const sec = await getAdminSecurity();
  if (!sec.lock_after_fail) return;
  const key = email.toLowerCase();
  const st = failByEmail.get(key) ?? { count: 0, lockedUntil: null };
  st.count += 1;
  if (st.count >= sec.max_fail_attempts) {
    st.lockedUntil = Date.now() + sec.lock_minutes * 60_000;
    st.count = 0;
  }
  failByEmail.set(key, st);
}

export function clearAdminLoginFailures(email: string): void {
  failByEmail.delete(email.toLowerCase());
}
