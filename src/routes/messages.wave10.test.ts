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
let otherConversationId = "";

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  userA = await loginAs(`711${stamp}`);
  userB = await loginAs(`722${stamp}`);
  const create = await app.inject({
    method: "POST",
    url: "/api/conversations/direct",
    headers: { authorization: `Bearer ${userA.access}` },
    payload: { user_id: userB.userId },
  });
  conversationId = create.json().id;

  const other = await app.inject({
    method: "POST",
    url: "/api/conversations/direct",
    headers: { authorization: `Bearer ${userA.access}` },
    payload: { user_id: userB.userId },
  });
  // same direct chat — create a group for forward target instead
  const group = await app.inject({
    method: "POST",
    url: "/api/conversations/group",
    headers: { authorization: `Bearer ${userA.access}` },
    payload: { title: "Wave10 Group", member_ids: [userB.userId] },
  });
  otherConversationId = group.json().id;
  void other;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("Wave 10 reply / react / star / forward", () => {
  it("replies, reacts, stars, and forwards", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "parent msg", client_id: `p-${Date.now()}` },
    });
    expect(send.statusCode).toBe(201);
    const parentId = send.json().id as string;

    const reply = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userB.access}` },
      payload: {
        text: "this is a reply",
        reply_to: { id: parentId },
        client_id: `r-${Date.now()}`,
      },
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().reply_to?.id).toBe(parentId);
    expect(reply.json().reply_to?.text).toBe("parent msg");

    const react = await app.inject({
      method: "POST",
      url: `/api/messages/${parentId}/reactions`,
      headers: { authorization: `Bearer ${userB.access}` },
      payload: { emoji: "👍" },
    });
    expect(react.statusCode).toBe(200);
    expect(react.json().reactions?.some((r: { emoji: string }) => r.emoji === "👍")).toBe(true);

    const star = await app.inject({
      method: "POST",
      url: `/api/messages/${parentId}/star`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: {},
    });
    expect(star.statusCode).toBe(200);
    expect(star.json().starred).toBe(true);

    const starred = await app.inject({
      method: "GET",
      url: "/api/me/starred",
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(starred.statusCode).toBe(200);
    expect(starred.json().items.some((m: { id: string }) => m.id === parentId)).toBe(true);

    const forward = await app.inject({
      method: "POST",
      url: `/api/messages/${parentId}/forward`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { conversation_id: otherConversationId },
    });
    expect(forward.statusCode).toBe(201);
    expect(forward.json().forwarded).toBe(true);
    expect(forward.json().text).toBe("parent msg");
    expect(forward.json().conversation_id).toBe(otherConversationId);
  });
});
