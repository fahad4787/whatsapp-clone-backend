import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../db.js";
import { hashPassword } from "../../auth/crypto.js";

const app = await buildApp();

async function adminAccess() {
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/auth/login",
    payload: {
      email: "admin@aivora.dev",
      password: "aivora-admin-change-me",
    },
  });
  expect(login.statusCode).toBe(200);
  return login.json().access as string;
}

async function userAccess(national: string) {
  const reqOtp = await app.inject({
    method: "POST",
    url: "/api/auth/otp/request",
    payload: { country: "92", national_number: national },
  });
  expect(reqOtp.statusCode).toBe(200);
  const phone = reqOtp.json().phone as string;
  const challenge = await prisma.otpChallenge.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/otp/verify",
    payload: { phone, code: challenge!.devCode ?? "000000" },
  });
  expect(verify.statusCode).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  return { access: verify.json().access as string, userId: user.id, phone };
}

beforeAll(async () => {
  await prisma.adminUser.upsert({
    where: { email: "admin@aivora.dev" },
    create: {
      email: "admin@aivora.dev",
      passwordHash: await hashPassword("aivora-admin-change-me"),
      displayName: "Superadmin",
      role: "SUPER",
    },
    update: {},
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("Wave 8 admin moderation", () => {
  it("lists users, bans them, and blocks OTP auth", async () => {
    const suffix = String(Date.now()).slice(-8);
    const a = await userAccess(`801${suffix}`.slice(0, 10));
    const token = await adminAccess();

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/users?q=" + encodeURIComponent(a.phone),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((u: { id: string }) => u.id === a.userId)).toBe(true);

    const ban = await app.inject({
      method: "POST",
      url: `/api/admin/users/${a.userId}/ban`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "spam" },
    });
    expect(ban.statusCode).toBe(200);
    expect(ban.json().banned).toBe(true);

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${a.access}` },
    });
    expect(me.statusCode).toBe(403);
    expect(me.json().error).toBe("banned");

    const otp = await app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: {
        country: "92",
        national_number: a.phone.replace("+92", ""),
      },
    });
    expect(otp.statusCode).toBe(403);

    const unban = await app.inject({
      method: "POST",
      url: `/api/admin/users/${a.userId}/unban`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unban.statusCode).toBe(200);
    expect(unban.json().banned).toBe(false);
  });

  it("creates a report, lists it, and resolves it", async () => {
    const suffix = String(Date.now()).slice(-8);
    const reporter = await userAccess(`802${suffix}`.slice(0, 10));
    const target = await userAccess(`803${suffix}`.slice(0, 10));
    const token = await adminAccess();

    const created = await app.inject({
      method: "POST",
      url: "/api/reports",
      headers: { authorization: `Bearer ${reporter.access}` },
      payload: {
        target_user_id: target.userId,
        reason: "harassment",
        message_ids: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const reportId = created.json().id as string;

    const open = await app.inject({
      method: "GET",
      url: "/api/admin/reports?status=open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(open.statusCode).toBe(200);
    expect(open.json().items.some((r: { id: string }) => r.id === reportId)).toBe(true);

    const resolved = await app.inject({
      method: "POST",
      url: `/api/admin/reports/${reportId}/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "resolve", note: "warned" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("resolved");

    const metrics = await app.inject({
      method: "GET",
      url: "/api/admin/metrics",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().users_total).toBeGreaterThan(0);
    expect(typeof metrics.json().messages_today).toBe("number");
    expect(typeof metrics.json().reports_open).toBe("number");
  });
});
