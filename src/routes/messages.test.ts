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
    payload: { phone, code: challenge!.devCode! },
  });
  const access = verify.json().access as string;
  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${access}` },
  });
  return { access, userId: me.json().id as string };
}

let userA: Awaited<ReturnType<typeof loginAs>>;
let userB: Awaited<ReturnType<typeof loginAs>>;
let conversationId = "";

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  userA = await loginAs(`511${stamp}`);
  userB = await loginAs(`522${stamp}`);
  const create = await app.inject({
    method: "POST",
    url: "/api/conversations/direct",
    headers: { authorization: `Bearer ${userA.access}` },
    payload: { user_id: userB.userId },
  });
  conversationId = create.json().id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("messages", () => {
  it("sends and lists text for both members", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "Hello from A", client_id: "c1" },
    });
    expect(send.statusCode).toBe(201);
    expect(send.json().text).toBe("Hello from A");

    const listB = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().items.some((m: { text: string }) => m.text === "Hello from A")).toBe(true);

    const reply = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userB.access}` },
      payload: { text: "Hi A, this is B" },
    });
    expect(reply.statusCode).toBe(201);

    const listA = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(listA.json().items.map((m: { text: string }) => m.text)).toEqual([
      "Hello from A",
      "Hi A, this is B",
    ]);
  });

  it("people list returns others without a query", async () => {
    const all = await app.inject({
      method: "GET",
      url: "/api/people/search",
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().items.some((u: { id: string }) => u.id === userB.userId)).toBe(true);
    expect(all.json().items.some((u: { id: string }) => u.id === userA.userId)).toBe(false);

    const hit = await app.inject({
      method: "GET",
      url: `/api/people/search?q=${encodeURIComponent("522")}`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(hit.statusCode).toBe(200);
  });
});

