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
  userA = await loginAs(`811${stamp}`);
  userB = await loginAs(`822${stamp}`);
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

describe("Wave 11 archive / mute / pin / block / search", () => {
  it("archives, mutes, pins, blocks, and searches", async () => {
    const muteUntil = new Date(Date.now() + 8 * 3600_000).toISOString();
    const settings = await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversationId}/settings`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { archived: true, muted_until: muteUntil, pinned: true },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().archived).toBe(true);
    expect(settings.json().pinned).toBe(true);
    expect(settings.json().muted_until).toBeTruthy();

    const list = await app.inject({
      method: "GET",
      url: "/api/conversations",
      headers: { authorization: `Bearer ${userA.access}` },
    });
    const item = list.json().items.find((c: { id: string }) => c.id === conversationId);
    expect(item?.archived).toBe(true);
    expect(item?.pinned).toBe(true);
    expect(item?.blocked_by_me).toBe(false);

    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "wave11 search needle unique", client_id: `w11-${Date.now()}` },
    });
    expect(send.statusCode).toBe(201);

    const search = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages?q=needle`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items.some((m: { text?: string }) => m.text?.includes("needle"))).toBe(
      true,
    );

    const block = await app.inject({
      method: "POST",
      url: "/api/blocks",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { user_id: userB.userId },
    });
    expect(block.statusCode).toBe(201);

    const blockedSend = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userB.access}` },
      payload: { text: "should fail", client_id: `w11b-${Date.now()}` },
    });
    expect(blockedSend.statusCode).toBe(403);

    const blocks = await app.inject({
      method: "GET",
      url: "/api/blocks",
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(blocks.json().items.some((b: { id: string }) => b.id === userB.userId)).toBe(true);

    const unblock = await app.inject({
      method: "DELETE",
      url: `/api/blocks/${userB.userId}`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(unblock.statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: `/api/conversations/${conversationId}/settings`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { archived: false, muted_until: null, pinned: false },
    });
  });
});
