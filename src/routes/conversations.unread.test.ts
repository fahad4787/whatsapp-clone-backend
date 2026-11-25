import { afterAll, describe, expect, it } from "vitest";
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

type User = Awaited<ReturnType<typeof loginAs>>;

async function unreadFor(user: User, conversationId: string) {
  const list = await app.inject({
    method: "GET",
    url: "/api/conversations",
    headers: { authorization: `Bearer ${user.access}` },
  });
  return list.json().items.find((c: { id: string }) => c.id === conversationId)
    ?.unread_count as number;
}

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("unread counts", () => {
  it("keeps a group message unread for each member until that member opens it", async () => {
    const stamp = String(Date.now()).slice(-7);
    const sender = await loginAs(`833${stamp}`);
    const first = await loginAs(`844${stamp}`);
    const second = await loginAs(`855${stamp}`);

    const create = await app.inject({
      method: "POST",
      url: "/api/conversations/group",
      headers: { authorization: `Bearer ${sender.access}` },
      payload: { title: "Unread group", member_ids: [first.userId, second.userId] },
    });
    const conversationId = create.json().id as string;
    const before = await unreadFor(second, conversationId);

    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${sender.access}` },
      payload: { text: "hey", client_id: `unread-${stamp}` },
    });
    expect(await unreadFor(second, conversationId)).toBe(before + 1);

    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/read`,
      headers: { authorization: `Bearer ${first.access}` },
    });
    expect(await unreadFor(first, conversationId)).toBe(0);
    expect(await unreadFor(second, conversationId)).toBe(before + 1);

    await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/read`,
      headers: { authorization: `Bearer ${second.access}` },
    });
    expect(await unreadFor(second, conversationId)).toBe(0);
  });
});
