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

let a: Awaited<ReturnType<typeof loginAs>>;
let b: Awaited<ReturnType<typeof loginAs>>;
let chatId = "";

beforeAll(async () => {
  const stamp = String(Date.now()).slice(-7);
  a = await loginAs(`633${stamp}`);
  b = await loginAs(`644${stamp}`);
  const create = await app.inject({
    method: "POST",
    url: "/api/conversations/direct",
    headers: { authorization: `Bearer ${a.access}` },
    payload: { user_id: b.userId },
  });
  chatId = create.json().id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function send(token: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/conversations/${chatId}/messages`,
    headers: auth(token),
    payload,
  });
}

describe("wave15 chat polish", () => {
  it("edits own text message within the window only", async () => {
    const sent = await send(a.access, { text: "helo" });
    const id = sent.json().id as string;

    const peerEdit = await app.inject({
      method: "PUT",
      url: `/api/messages/${id}`,
      headers: auth(b.access),
      payload: { text: "nope" },
    });
    expect(peerEdit.statusCode).toBe(403);

    const edit = await app.inject({
      method: "PUT",
      url: `/api/messages/${id}`,
      headers: auth(a.access),
      payload: { text: "hello" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().text).toBe("hello");
    expect(edit.json().edited_at).toBeTruthy();

    await prisma.message.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 16 * 60_000) },
    });
    const late = await app.inject({
      method: "PUT",
      url: `/api/messages/${id}`,
      headers: auth(a.access),
      payload: { text: "too late" },
    });
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toBe("edit_window_expired");
  });

  it("sets favorite and wallpaper independent of pin", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/conversations/${chatId}/settings`,
      headers: auth(a.access),
      payload: { favorite: true, wallpaper: "mint" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().favorite).toBe(true);
    expect(res.json().pinned).toBe(false);

    const conv = await app.inject({
      method: "GET",
      url: `/api/conversations/${chatId}`,
      headers: auth(a.access),
    });
    expect(conv.json().favorite).toBe(true);
    expect(conv.json().wallpaper).toBe("mint");

    const other = await app.inject({
      method: "GET",
      url: `/api/conversations/${chatId}`,
      headers: auth(b.access),
    });
    expect(other.json().favorite).toBe(false);

    const clear = await app.inject({
      method: "PUT",
      url: `/api/conversations/${chatId}/settings`,
      headers: auth(a.access),
      payload: { favorite: false, wallpaper: null },
    });
    expect(clear.json().favorite).toBe(false);
    expect(clear.json().wallpaper).toBeNull();
  });

  it("reports delivered/read receipts in message info", async () => {
    const sent = await send(a.access, { text: "receipts" });
    const id = sent.json().id as string;

    await app.inject({
      method: "GET",
      url: `/api/conversations/${chatId}/messages`,
      headers: auth(b.access),
    });
    let info = await app.inject({
      method: "GET",
      url: `/api/messages/${id}/info`,
      headers: auth(a.access),
    });
    expect(info.statusCode).toBe(200);
    expect(info.json().delivered.map((r: { user_id: string }) => r.user_id)).toEqual([b.userId]);
    expect(info.json().read).toEqual([]);

    await app.inject({
      method: "POST",
      url: `/api/conversations/${chatId}/read`,
      headers: auth(b.access),
    });
    info = await app.inject({
      method: "GET",
      url: `/api/messages/${id}/info`,
      headers: auth(a.access),
    });
    expect(info.json().read[0].user_id).toBe(b.userId);
    expect(info.json().read[0].display_name).toBeTruthy();
    expect(info.json().message.id).toBe(id);
  });

  it("opens view-once images once per viewer", async () => {
    const bad = await send(a.access, { text: "x", view_once: true });
    expect(bad.statusCode).toBe(400);

    const sent = await send(a.access, {
      view_once: true,
      attachment: { key: "k1", url: "https://example.com/p.png", mime: "image/png" },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().view_once).toBe(true);
    const id = sent.json().id as string;

    const open = await app.inject({
      method: "POST",
      url: `/api/messages/${id}/view-once`,
      headers: auth(b.access),
    });
    expect(open.statusCode).toBe(200);
    expect(open.json().attachment).toBeTruthy();

    const again = await app.inject({
      method: "POST",
      url: `/api/messages/${id}/view-once`,
      headers: auth(b.access),
    });
    expect(again.json().attachment).toBeNull();
    expect(again.json().text).toBe("Opened");

    const list = await app.inject({
      method: "GET",
      url: `/api/conversations/${chatId}/messages`,
      headers: auth(a.access),
    });
    const mine = list.json().items.find((m: { id: string }) => m.id === id);
    expect(mine.attachment).toBeNull();
    expect(mine.text).toBe("Opened");
  });
});
