import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";

const app = await buildApp();
const national = `3${String(Date.now()).slice(-9)}`;
let phone = "";
let access = "";

beforeAll(async () => {
  const req = await app.inject({
    method: "POST",
    url: "/api/auth/otp/request",
    payload: { country: "92", national_number: national },
  });
  phone = req.json().phone;
  const challenge = await prisma.otpChallenge.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/otp/verify",
    payload: { phone, code: challenge!.devCode! },
  });
  access = verify.json().access;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("profile /api/me", () => {
  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("updates display_name and about", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/me",
      headers: { authorization: `Bearer ${access}` },
      payload: { display_name: "Wave Two", about: "Hello from Wave 2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().display_name).toBe("Wave Two");
    expect(res.json().about).toBe("Hello from Wave 2");

    const get = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(get.json().display_name).toBe("Wave Two");
  });

  it("uploads and deletes avatar", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const boundary = "----aivoraTestBoundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/me/avatar",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().avatar_url).toContain("/uploads/avatars/");

    const del = await app.inject({
      method: "DELETE",
      url: "/api/me/avatar",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().avatar_url).toBeNull();
  });
});
