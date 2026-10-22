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
  userA = await loginAs(`711${stamp}`);
  userB = await loginAs(`722${stamp}`);
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

describe("media", () => {
  it("presigns, uploads, and sends an image message", async () => {
    const presign = await app.inject({
      method: "POST",
      url: "/api/media/presign",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { content_type: "image/jpeg", filename: "shot.jpg" },
    });
    expect(presign.statusCode).toBe(200);
    const { key, upload_url, public_url } = presign.json() as {
      key: string;
      upload_url: string;
      public_url: string;
    };
    expect(key).toContain(userA.userId);
    expect(upload_url).toContain("/api/media/upload/");
    expect(public_url).toContain("/uploads/media/");

    const uploadPath = new URL(upload_url).pathname;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const put = await app.inject({
      method: "PUT",
      url: uploadPath,
      headers: {
        authorization: `Bearer ${userA.access}`,
        "content-type": "image/png",
      },
      payload: png,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().url).toContain(key);

    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: {
        text: "Look",
        client_id: `img-${Date.now()}`,
        attachment: {
          key,
          url: public_url,
          mime: "image/png",
          size: png.length,
        },
      },
    });
    expect(send.statusCode).toBe(201);
    expect(send.json().type).toBe("image");
    expect(send.json().attachment.url).toContain("/uploads/media/");

    const list = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((m: { type: string }) => m.type === "image")).toBe(true);

    const staticGet = await app.inject({
      method: "GET",
      url: `/uploads/media/${key}`,
    });
    expect(staticGet.statusCode).toBe(200);
  });
});
