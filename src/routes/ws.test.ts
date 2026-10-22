import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { realtimeHub } from "../realtime/hub.js";

const app = await buildApp();
let port = 0;

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

function waitFrame(ws: WebSocket, type: string, ms = 5000): Promise<{ type: string; data?: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: unknown };
      if (frame.type !== type) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(frame);
    };
    ws.on("message", onMessage);
  });
}

async function openSocket(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const authPromise = waitFrame(ws, "auth.ok");
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const auth = await authPromise;
  return { ws, auth };
}

let userA: Awaited<ReturnType<typeof loginAs>>;
let userB: Awaited<ReturnType<typeof loginAs>>;
let conversationId = "";

beforeAll(async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
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
  realtimeHub.reset();
  await app.close();
  await prisma.$disconnect();
});

describe("websocket", () => {
  it("rejects missing token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const code = await new Promise<number>((resolve, reject) => {
      ws.once("close", (c) => resolve(c));
      ws.once("error", reject);
      setTimeout(() => reject(new Error("no close")), 5000);
    });
    expect(code).toBe(4401);
  });

  it("auths, joins, relays typing and new messages", async () => {
    const a = await openSocket(userA.access);
    const b = await openSocket(userB.access);
    expect((a.auth.data as { user_id: string }).user_id).toBe(userA.userId);

    const joinedA = waitFrame(a.ws, "joined");
    const joinedB = waitFrame(b.ws, "joined");
    a.ws.send(JSON.stringify({ type: "join", data: { conversation_id: conversationId } }));
    b.ws.send(JSON.stringify({ type: "join", data: { conversation_id: conversationId } }));
    await Promise.all([joinedA, joinedB]);

    const typingPromise = waitFrame(b.ws, "typing");
    a.ws.send(
      JSON.stringify({
        type: "typing",
        data: { conversation_id: conversationId, typing: true },
      }),
    );
    const typing = await typingPromise;
    expect((typing.data as { typing: boolean }).typing).toBe(true);

    const msgPromise = waitFrame(b.ws, "message");
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${userA.access}` },
      payload: { text: "ws hello", client_id: `ws-${Date.now()}` },
    });
    expect(send.statusCode).toBe(201);
    const pushed = await msgPromise;
    expect((pushed.data as { text: string }).text).toBe("ws hello");

    a.ws.close();
    b.ws.close();
  }, 15_000);
});
