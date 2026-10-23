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

  it("sends audio and file messages and lists gallery", async () => {
    const audioPresign = await app.inject({
      method: "POST",
      url: "/api/media/presign",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { content_type: "audio/mp4", filename: "note.m4a" },
    });
    expect(audioPresign.statusCode).toBe(200);
    const audioKey = audioPresign.json().key as string;
    const audioPut = await app.inject({
      method: "PUT",
      url: `/api/media/upload/${encodeURIComponent(audioKey)}`,
      headers: {
        authorization: `Bearer ${userA.access}`,
        "content-type": "audio/mp4",
      },
      payload: Buffer.from("voice"),
    });
    expect(audioPut.statusCode).toBe(200);

    const voice = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: {
        client_id: `aud-${Date.now()}`,
        attachment: {
          key: audioKey,
          url: audioPresign.json().public_url,
          mime: "audio/mp4",
          size: 5,
          duration: 4,
          name: "note.m4a",
        },
      },
    });
    expect(voice.statusCode).toBe(201);
    expect(voice.json().type).toBe("audio");

    const pdfPresign = await app.inject({
      method: "POST",
      url: "/api/media/presign",
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { content_type: "application/pdf", filename: "doc.pdf" },
    });
    const pdfKey = pdfPresign.json().key as string;
    await app.inject({
      method: "PUT",
      url: `/api/media/upload/${encodeURIComponent(pdfKey)}`,
      headers: {
        authorization: `Bearer ${userA.access}`,
        "content-type": "application/pdf",
      },
      payload: Buffer.from("%PDF-1.4"),
    });
    const doc = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: {
        client_id: `file-${Date.now()}`,
        attachment: {
          key: pdfKey,
          url: pdfPresign.json().public_url,
          mime: "application/pdf",
          size: 8,
          name: "doc.pdf",
        },
      },
    });
    expect(doc.statusCode).toBe(201);
    expect(doc.json().type).toBe("file");

    const gallery = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/media`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(gallery.statusCode).toBe(200);
    expect(gallery.json().items.length).toBeGreaterThanOrEqual(2);

    const counts = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/media/counts`,
      headers: { authorization: `Bearer ${userB.access}` },
    });
    expect(counts.statusCode).toBe(200);
    expect(counts.json().audio).toBeGreaterThanOrEqual(1);
    expect(counts.json().docs).toBeGreaterThanOrEqual(1);
  });

  it("unfurls a link preview on text send", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: {
        text: "Check https://example.com please",
        client_id: `link-${Date.now()}`,
      },
    });
    expect(send.statusCode).toBe(201);
    expect(send.json().type).toBe("text");
    const preview = send.json().preview as { url?: string; site?: string } | null;
    expect(preview?.url).toContain("example.com");
  });
});
