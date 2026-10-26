import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";

const app = await buildApp();

async function userAccess(national: string) {
  const reqOtp = await app.inject({
    method: "POST",
    url: "/api/auth/otp/request",
    payload: { country: "92", national_number: national },
  });
  expect(reqOtp.statusCode).toBe(200);
  const phone = reqOtp.json().phone as string;
  const challenge = await prisma.otpChallenge.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/otp/verify",
    payload: { phone, code: challenge!.devCode ?? "000000" },
  });
  expect(verify.statusCode).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  return { access: verify.json().access as string, userId: user.id };
}

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("Wave 16 calls", () => {
  it("starts, answers, and ends a 1:1 call with LiveKit tokens", async () => {
    process.env.LIVEKIT_URL = "wss://test.livekit.cloud";
    process.env.LIVEKIT_API_KEY = "APItestkey";
    process.env.LIVEKIT_API_SECRET = "testsecretvaluefortoken";

    const suffix = String(Date.now()).slice(-8);
    const a = await userAccess(`910${suffix}`.slice(0, 10));
    const b = await userAccess(`911${suffix}`.slice(0, 10));

    const dm = await app.inject({
      method: "POST",
      url: "/api/conversations/direct",
      headers: { authorization: `Bearer ${a.access}` },
      payload: { user_id: b.userId },
    });
    expect(dm.statusCode).toBeLessThan(300);
    const conversationId = dm.json().id as string;

    const start = await app.inject({
      method: "POST",
      url: "/api/calls",
      headers: { authorization: `Bearer ${a.access}` },
      payload: { conversation_id: conversationId, media: "audio" },
    });
    expect(start.statusCode).toBe(201);
    const started = start.json() as {
      token: string;
      livekit_url: string;
      call: { id: string; status: string; media: string };
    };
    expect(started.token.length).toBeGreaterThan(20);
    expect(started.livekit_url).toContain("livekit");
    expect(started.call.status).toBe("ringing");
    expect(started.call.media).toBe("audio");

    const answer = await app.inject({
      method: "POST",
      url: `/api/calls/${started.call.id}/answer`,
      headers: { authorization: `Bearer ${b.access}` },
      payload: {},
    });
    expect(answer.statusCode).toBe(200);
    const answered = answer.json() as { token: string; call: { status: string } };
    expect(answered.token.length).toBeGreaterThan(20);
    expect(answered.call.status).toBe("active");

    const end = await app.inject({
      method: "POST",
      url: `/api/calls/${started.call.id}/end`,
      headers: { authorization: `Bearer ${a.access}` },
      payload: {},
    });
    expect(end.statusCode).toBe(200);
    expect(end.json().call.status).toBe("ended");
  });

  it("rejects start when LiveKit env is missing", async () => {
    const prev = {
      url: process.env.LIVEKIT_URL,
      key: process.env.LIVEKIT_API_KEY,
      secret: process.env.LIVEKIT_API_SECRET,
    };
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;

    const suffix = String(Date.now()).slice(-8);
    const a = await userAccess(`912${suffix}`.slice(0, 10));
    const res = await app.inject({
      method: "POST",
      url: "/api/calls",
      headers: { authorization: `Bearer ${a.access}` },
      payload: { user_ids: ["someone"], media: "audio" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("livekit_not_configured");

    process.env.LIVEKIT_URL = prev.url;
    process.env.LIVEKIT_API_KEY = prev.key;
    process.env.LIVEKIT_API_SECRET = prev.secret;
  });
});
