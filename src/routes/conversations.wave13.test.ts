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

let admin: Awaited<ReturnType<typeof loginAs>>;
let member: Awaited<ReturnType<typeof loginAs>>;
let extra: Awaited<ReturnType<typeof loginAs>>;
let groupId = "";

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  admin = await loginAs(`411${stamp}`);
  member = await loginAs(`422${stamp}`);
  extra = await loginAs(`433${stamp}`);
  const create = await app.inject({
    method: "POST",
    url: "/api/conversations/group",
    headers: { authorization: `Bearer ${admin.access}` },
    payload: { title: "Wave13 Group", member_ids: [member.userId] },
  });
  expect(create.statusCode).toBe(201);
  groupId = create.json().id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("wave13 groups", () => {
  it("adds and removes members as admin", async () => {
    const add = await app.inject({
      method: "POST",
      url: `/api/conversations/${groupId}/members`,
      headers: { authorization: `Bearer ${admin.access}` },
      payload: { user_ids: [extra.userId] },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().members.some((m: { user: { id: string } }) => m.user.id === extra.userId)).toBe(
      true,
    );

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${groupId}/members/${extra.userId}`,
      headers: { authorization: `Bearer ${admin.access}` },
    });
    expect(remove.statusCode).toBe(200);
    expect(
      remove.json().members.some((m: { user: { id: string } }) => m.user.id === extra.userId),
    ).toBe(false);
  });

  it("promotes and demotes members", async () => {
    const promote = await app.inject({
      method: "PUT",
      url: `/api/conversations/${groupId}/members/${member.userId}`,
      headers: { authorization: `Bearer ${admin.access}` },
      payload: { role: "admin" },
    });
    expect(promote.statusCode).toBe(200);
    const promoted = promote.json().members.find(
      (m: { user: { id: string }; role: string }) => m.user.id === member.userId,
    );
    expect(promoted.role).toBe("admin");

    const demote = await app.inject({
      method: "PUT",
      url: `/api/conversations/${groupId}/members/${member.userId}`,
      headers: { authorization: `Bearer ${admin.access}` },
      payload: { role: "member" },
    });
    expect(demote.statusCode).toBe(200);
    const demoted = demote.json().members.find(
      (m: { user: { id: string }; role: string }) => m.user.id === member.userId,
    );
    expect(demoted.role).toBe("member");
  });

  it("edits group info and privacy flags", async () => {
    const info = await app.inject({
      method: "PUT",
      url: `/api/conversations/${groupId}/info`,
      headers: { authorization: `Bearer ${admin.access}` },
      payload: { title: "Wave13 Renamed", description: "Hello group" },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json().title).toBe("Wave13 Renamed");
    expect(info.json().description).toBe("Hello group");

    const privacy = await app.inject({
      method: "PUT",
      url: `/api/conversations/${groupId}/privacy`,
      headers: { authorization: `Bearer ${admin.access}` },
      payload: { only_admins_can_send: true, only_admins_can_edit_info: true },
    });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.json().only_admins_can_send).toBe(true);
    expect(privacy.json().only_admins_can_edit_info).toBe(true);

    const blocked = await app.inject({
      method: "POST",
      url: `/api/conversations/${groupId}/messages`,
      headers: { authorization: `Bearer ${member.access}` },
      payload: { text: "should fail" },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("admins_only");

    const ok = await app.inject({
      method: "POST",
      url: `/api/conversations/${groupId}/messages`,
      headers: { authorization: `Bearer ${admin.access}` },
      payload: { text: "admin can send" },
    });
    expect(ok.statusCode).toBe(201);

    // restore send for later tests
    await app.inject({
      method: "PUT",
      url: `/api/conversations/${groupId}/privacy`,
      headers: { authorization: `Bearer ${admin.access}` },
      payload: { only_admins_can_send: false },
    });
  });

  it("leaves group and dissolves as admin", async () => {
    const stamp = String(Date.now()).slice(-6);
    const a = await loginAs(`511${stamp}`);
    const b = await loginAs(`522${stamp}`);
    const create = await app.inject({
      method: "POST",
      url: "/api/conversations/group",
      headers: { authorization: `Bearer ${a.access}` },
      payload: { title: "Temp", member_ids: [b.userId] },
    });
    const id = create.json().id as string;

    const leave = await app.inject({
      method: "POST",
      url: `/api/conversations/${id}/leave`,
      headers: { authorization: `Bearer ${b.access}` },
      payload: {},
    });
    expect(leave.statusCode).toBe(200);

    const listB = await app.inject({
      method: "GET",
      url: "/api/conversations",
      headers: { authorization: `Bearer ${b.access}` },
    });
    expect(listB.json().items.some((c: { id: string }) => c.id === id)).toBe(false);

    const dissolve = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${id}`,
      headers: { authorization: `Bearer ${a.access}` },
    });
    expect(dissolve.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: `/api/conversations/${id}`,
      headers: { authorization: `Bearer ${a.access}` },
    });
    expect(get.statusCode).toBe(404);
  });
});
