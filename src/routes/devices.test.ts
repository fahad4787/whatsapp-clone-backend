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
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/otp/verify",
    payload: {
      phone,
      code: challenge!.devCode!,
      device: { platform: "android", device_name: "test" },
    },
  });
  return { access: verify.json().access as string };
}

let access = "";

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  access = (await loginAs(`811${stamp}`)).access;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("devices / push token", () => {
  it("registers a push token on the user device", async () => {
    const token = `fcm-test-token-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const put = await app.inject({
      method: "PUT",
      url: "/api/me/push-token",
      headers: { authorization: `Bearer ${access}` },
      payload: { push_token: token, platform: "android", device_name: "Pixel" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().has_push_token).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/me/devices",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((d: { has_push_token: boolean }) => d.has_push_token)).toBe(
      true,
    );

    const row = await prisma.device.findFirst({
      where: { pushToken: token },
    });
    expect(row).toBeTruthy();
  });
});
