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
  userA = await loginAs(`311${stamp}`);
  userB = await loginAs(`322${stamp}`);
  userC = await loginAs(`333${stamp}`);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("conversations", () => {
  it("creates a direct chat visible to both users", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/conversations/direct",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { user_id: userB.userId },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().type).toBe("direct");
    expect(create.json().peer.id).toBe(userB.userId);

    const again = await app.inject({
      method: "POST",
      url: "/api/conversations/direct",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { user_id: userB.userId },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(create.json().id);

    const listB = await app.inject({
      method: "GET",
      url: "/api/conversations",
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().items.some((c: { id: string }) => c.id === create.json().id)).toBe(true);
  });

  it("creates a group and lists it for members", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/conversations/group",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { title: "Wave 3 Group", member_ids: [userB.userId, userC.userId] },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().type).toBe("group");
    expect(create.json().title).toBe("Wave 3 Group");
    expect(create.json().members.length).toBe(3);

    const listC = await app.inject({
      method: "GET",
      url: "/api/conversations",
      headers: { authorization: `Bearer ${userC.access}` },
    });
    expect(listC.json().items.some((c: { title: string }) => c.title === "Wave 3 Group")).toBe(true);

    const add = await app.inject({
      method: "POST",
      url: `/api/conversations/${create.json().id}/members`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { user_ids: [userB.userId] },
    });
    expect(add.statusCode).toBe(200);
  });

  it("lists and searches people for new chat", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/people/search",
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.some((u: { id: string }) => u.id === userB.userId)).toBe(true);
    expect(listed.json().items.some((u: { id: string }) => u.id === userA.userId)).toBe(false);

    const res = await app.inject({
      method: "GET",
      url: `/api/people/search?q=${encodeURIComponent(userB.phone.slice(-4))}`,
      headers: { authorization: `Bearer ${userA.access}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.some((u: { id: string }) => u.id === userB.userId)).toBe(true);
  });
});

