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
let userC: Awaited<ReturnType<typeof loginAs>>;

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  userA = await loginAs(`518${stamp}`);
  userB = await loginAs(`519${stamp}`);
  userC = await loginAs(`520${stamp}`);
  await app.inject({
    method: "POST",
    url: "/api/conversations/direct",
    headers: { authorization: `Bearer ${userA.access}` },
    payload: { user_id: userB.userId },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("Wave 18 status", () => {
  it("creates a status and shows it to a contact", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { kind: "text", text: "Hello status", background: "#075E54" },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().text).toBe("Hello status");
    expect(create.json().expires_at).toBeTruthy();

    const feedB = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(feedB.statusCode).toBe(200);
    const rows = feedB.json().items as { user: { id: string }; statuses: { text: string }[] }[];
    const fromA = rows.find((r) => r.user.id === userA.userId);
    expect(fromA?.statuses.some((s) => s.text === "Hello status")).toBe(true);

    const feedC = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${userC.access}` },
    });
    const fromAForC = (feedC.json().items as { user: { id: string }; statuses: unknown[] }[]).find(
      (r) => r.user.id === userA.userId,
    );
    expect(fromAForC).toBeUndefined();
  });

  it("marks viewed and lists viewers for owner", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "View me" },
    });
    const id = create.json().id as string;

    const view = await app.inject({
      method: "POST",
      url: `/api/status/${id}`,
      headers: { authorization: `Bearer ${userB.access}` },
      payload: {},
    });
    expect(view.statusCode).toBe(200);

    const viewers = await app.inject({
      method: "GET",
      url: `/api/status/${id}/viewers`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(viewers.statusCode).toBe(200);
    expect(
      (viewers.json().items as { user: { id: string } }[]).some((v) => v.user.id === userB.userId),
    ).toBe(true);
  });

  it("hides status when blocked", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "Blocked status" },
    });
    const id = create.json().id as string;

    await app.inject({
      method: "POST",
      url: "/api/blocks",
      headers: { authorization: `Bearer ${userB.access}` },
      payload: { user_id: userA.userId },
    });

    const feedB = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${userB.access}` },
    });
    const fromA = (feedB.json().items as { user: { id: string }; statuses: { id: string }[] }[]).find(
      (r) => r.user.id === userA.userId,
    );
    expect(fromA?.statuses.some((s) => s.id === id) ?? false).toBe(false);

    await app.inject({
      method: "DELETE",
      url: `/api/blocks/${userA.userId}`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
  });

  it("filters expired statuses", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "Expire soon" },
    });
    const id = create.json().id as string;
    await prisma.status.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const feed = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${userA.access}` },
    });
    const mine = (feed.json().items as { user: { id: string }; statuses: { id: string }[] }[]).find(
      (r) => r.user.id === userA.userId,
    );
    expect(mine?.statuses.some((s) => s.id === id) ?? false).toBe(false);
  });

  it("updates status privacy on me/privacy", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/me/privacy",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { status: "only_share", status_ids: [userB.userId] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().status).toBe("only_share");
    expect(put.json().status_ids).toContain(userB.userId);
  });
});
