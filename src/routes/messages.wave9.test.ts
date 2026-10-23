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
  userA = await loginAs(`611${stamp}`);
  userB = await loginAs(`622${stamp}`);
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

describe("Wave 9 receipts + delete", () => {
  it("marks delivered when peer lists, read when peer opens", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "receipts check", client_id: `r-${Date.now()}` },
    });
    expect(send.statusCode).toBe(201);
    const messageId = send.json().id as string;

    const listB = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(listB.statusCode).toBe(200);
    const afterList = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(["DELIVERED", "READ"]).toContain(afterList.status);

    const read = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/read`,
      headers: { authorization: `Bearer ${userB.access}` },
      payload: {},
    });
    expect(read.statusCode).toBe(204);
    const afterRead = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(afterRead.status).toBe("READ");
  });

  it("deletes for me and for everyone; clear chat hides history", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "delete me", client_id: `d-${Date.now()}` },
    });
    const messageId = send.json().id as string;

    const hide = await app.inject({
      method: "DELETE",
      url: `/api/messages/${messageId}?for=me`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(hide.statusCode).toBe(204);

    const listA = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(listA.json().items.some((m: { id: string }) => m.id === messageId)).toBe(false);

    const listB = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(listB.json().items.some((m: { id: string }) => m.id === messageId)).toBe(true);

    const send2 = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "gone for all", client_id: `e-${Date.now()}` },
    });
    const id2 = send2.json().id as string;

    const everyone = await app.inject({
      method: "DELETE",
      url: `/api/messages/${id2}?for=everyone`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(everyone.statusCode).toBe(200);
    expect(everyone.json().deleted_for_everyone_at).toBeTruthy();
    expect(everyone.json().text).toBeNull();

    const clear = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/clear`,
      headers: { authorization: `Bearer ${userB.access}` },
      payload: {},
    });
    expect(clear.statusCode).toBe(204);

    const listBAfterClear = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(listBAfterClear.json().items).toEqual([]);
  });
});
