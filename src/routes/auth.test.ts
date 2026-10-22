import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/crypto.js";

const app = await buildApp();

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

describe("auth otp flow", () => {
  const national = String(Date.now()).slice(-10);
  let phone = "";
  let code = "";
  let access = "";
  let refresh = "";

  it("requests OTP and stores challenge", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: { country: "92", national_number: national },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    phone = body.phone;
    expect(phone).toBe(`+92${national}`);
    expect(body.expires_in).toBeGreaterThan(0);

    const challenge = await prisma.otpChallenge.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });
    expect(challenge?.devCode).toBeTruthy();
    code = challenge!.devCode!;
  });

  it("rejects invalid OTP", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/otp/verify",
      payload: { phone, code: "111111" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("verifies OTP and returns tokens", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/otp/verify",
      payload: {
        phone,
        code,
        device: { platform: "android", device_name: "test" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access).toBeTruthy();
    expect(body.refresh).toBeTruthy();
    access = body.access;
    refresh = body.refresh;
  });

  it("returns /api/me with access token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().phone).toBe(phone);
  });

  it("rotates refresh token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access).toBeTruthy();
    expect(body.refresh).toBeTruthy();
    expect(body.refresh).not.toBe(refresh);

    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh },
    });
    expect(reuse.statusCode).toBe(401);
    refresh = body.refresh;
    access = body.access;
  });

  it("logs out and invalidates refresh", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      payload: { refresh },
    });
    expect(res.statusCode).toBe(204);

    const again = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh },
    });
    expect(again.statusCode).toBe(401);
  });
});

describe("admin auth + otp list", () => {
  it("logs in admin and lists OTP codes", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      payload: {
        email: "admin@aivora.dev",
        password: "aivora-admin-change-me",
      },
    });
    expect(login.statusCode).toBe(200);
    const { access } = login.json();
    expect(access).toBeTruthy();

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/otps",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().items)).toBe(true);
    expect(list.json().items.length).toBeGreaterThan(0);
  });
});
