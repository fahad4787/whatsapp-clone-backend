import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";

const app = await buildApp();

async function loginAs(national: string) {
  await app.inject({
    method: "POST",
    url: "/api/auth/otp/request",
    payload: { country: "92", national_number: national },
  });
  const phone = `+92${national}`;
  const challenge = await prisma.otpChallenge.findFirst({
    where: { phone, purpose: "login" },
    orderBy: { createdAt: "desc" },
  });
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/otp/verify",
    payload: {
      phone,
      code: challenge!.devCode ?? "000000",
      device: { platform: "android", device_name: "test" },
    },
  });
  return {
    access: verify.json().access as string | undefined,
    body: verify.json() as Record<string, unknown>,
    phone,
  };
}

const stamp = String(Date.now()).slice(-7);
const national = `822${stamp}`;
let access = "";
let phone = "";

beforeAll(async () => {
  const session = await loginAs(national);
  access = session.access!;
  phone = session.phone;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("Wave 22 identity", () => {
  it("enables two-step and requires PIN after OTP", async () => {
    const enable = await app.inject({
      method: "PATCH",
      url: "/api/me/two-step",
      headers: { authorization: `Bearer ${access}` },
      payload: { pin: "123456" },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().enabled).toBe(true);

    await app.inject({
      method: "POST",
      url: "/api/auth/otp/request",
      payload: { country: "92", national_number: national },
    });
    const challenge = await prisma.otpChallenge.findFirst({
      where: { phone, purpose: "login" },
      orderBy: { createdAt: "desc" },
    });
    const verify = await app.inject({
      method: "POST",
      url: "/api/auth/otp/verify",
      payload: { phone, code: challenge!.devCode ?? "000000" },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().two_step_required).toBe(true);
    expect(verify.json().challenge).toBeTruthy();
    expect(verify.json().access).toBeUndefined();

    const pinOk = await app.inject({
      method: "POST",
      url: "/api/auth/two-step",
      payload: {
        challenge: verify.json().challenge,
        pin: "123456",
        device: { platform: "android", device_name: "relogin" },
      },
    });
    expect(pinOk.statusCode).toBe(200);
    expect(pinOk.json().access).toBeTruthy();
    access = pinOk.json().access;
  });

  it("changes number via OTP", async () => {
    const newNational = `833${stamp}`;
    const req = await app.inject({
      method: "POST",
      url: "/api/me/change-number/request",
      headers: { authorization: `Bearer ${access}` },
      payload: { country: "92", national_number: newNational },
    });
    expect(req.statusCode).toBe(200);
    const newPhone = req.json().phone as string;
    const challenge = await prisma.otpChallenge.findFirst({
      where: { phone: newPhone, purpose: "change_number" },
      orderBy: { createdAt: "desc" },
    });
    const verify = await app.inject({
      method: "POST",
      url: "/api/me/change-number/verify",
      headers: { authorization: `Bearer ${access}` },
      payload: { phone: newPhone, code: challenge!.devCode ?? "000000" },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().phone).toBe(newPhone);
    phone = newPhone;
  });

  it("deletes account after phone confirm", async () => {
    const del = await app.inject({
      method: "POST",
      url: "/api/me/delete",
      headers: { authorization: `Bearer ${access}` },
      payload: { phone },
    });
    expect(del.statusCode).toBe(204);
    const gone = await prisma.user.findUnique({ where: { phone } });
    expect(gone).toBeNull();
  });
});
