import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";

const app = await buildApp();

async function loginAs(national: string) {
  const req = await app.inject({
    method: "POST",
    url: "/api/auth/otp/request",
    payload: { country: "92", national_number: national },
  });
  const phone = req.json().phone as string;
  const challenge = await prisma.otpChallenge.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/otp/verify",
    payload: { phone, code: challenge!.devCode! },
  });
  const access = verify.json().access as string;
  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${access}` },
  });
  return { access, userId: me.json().id as string, phone };
}

let userA: Awaited<ReturnType<typeof loginAs>>;
let userB: Awaited<ReturnType<typeof loginAs>>;
let conversationId: string;

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  userA = await loginAs(`417${stamp}`);
  userB = await loginAs(`418${stamp}`);
  const create = await app.inject({
    method: "POST",
    url: "/api/conversations/direct",
    headers: { authorization: `Bearer ${userA.access}` },
    payload: { user_id: userB.userId },
  });
  conversationId = create.json().id as string;
  await app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/messages`,
    headers: { authorization: `Bearer ${userA.access}` },
    payload: { type: "text", text: "Export me please" },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("Wave 17 conversation export", () => {
  it("rejects non-members", async () => {
    const stranger = await loginAs(`419${String(Date.now()).slice(-7)}`);
    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/export`,
      headers: { authorization: `Bearer ${stranger.access}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns plaintext without media", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/export?media=0`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("Export me please");
    expect(res.body).toContain("Aivora Chat Export");
  });

  it("returns zip when media=1", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/export?media=1`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/zip/);
    expect(res.rawPayload.length).toBeGreaterThan(20);
    // ZIP local file header magic
    expect(res.rawPayload[0]).toBe(0x50);
    expect(res.rawPayload[1]).toBe(0x4b);
  });
});
