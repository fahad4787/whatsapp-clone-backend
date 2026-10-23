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
  a = await loginAs(`611${stamp}`);
  b = await loginAs(`622${stamp}`);
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

describe("wave14 chat extras", () => {
  it("sends contact, location, poll, event", async () => {
    const contact = await app.inject({
      method: "POST",
      url: `/api/conversations/${chatId}/messages`,
      headers: { authorization: `Bearer ${a.access}` },
      payload: { contact: { name: "Ada", phones: ["+100"], user_id: b.userId } },
    });
    expect(contact.statusCode).toBe(201);
    expect(contact.json().type).toBe("contact");
    expect(contact.json().contact.name).toBe("Ada");

    const loc = await app.inject({
      method: "POST",
      url: `/api/conversations/${chatId}/messages`,
      headers: { authorization: `Bearer ${a.access}` },
      payload: { location: { lat: 31.5, lng: 74.3, name: "Lahore" } },
    });
    expect(loc.statusCode).toBe(201);
    expect(loc.json().type).toBe("location");
    expect(loc.json().location.lat).toBe(31.5);

    const poll = await app.inject({
      method: "POST",
      url: `/api/conversations/${chatId}/messages`,
      headers: { authorization: `Bearer ${a.access}` },
      payload: { poll: { question: "Lunch?", options: ["Yes", "No"], multiple: false } },
    });
    expect(poll.statusCode).toBe(201);
    expect(poll.json().type).toBe("poll");
    const pollId = poll.json().id as string;
    const optionId = poll.json().poll.options[0].id as string;

    const vote = await app.inject({
      method: "POST",
      url: `/api/messages/${pollId}/vote`,
      headers: { authorization: `Bearer ${b.access}` },
      payload: { option_id: optionId },
    });
    expect(vote.statusCode).toBe(200);
    expect(vote.json().poll.options[0].votes).toBe(1);
    expect(vote.json().poll.options[0].mine).toBe(true);

    const event = await app.inject({
      method: "POST",
      url: `/api/conversations/${chatId}/messages`,
      headers: { authorization: `Bearer ${a.access}` },
      payload: {
        event: {
          title: "Meetup",
          starts_at: new Date(Date.now() + 86400_000).toISOString(),
          location: "Cafe",
        },
      },
    });
    expect(event.statusCode).toBe(201);
    const eventId = event.json().id as string;
    const rsvp = await app.inject({
      method: "POST",
      url: `/api/messages/${eventId}/rsvp`,
      headers: { authorization: `Bearer ${b.access}` },
      payload: { answer: "going" },
    });
    expect(rsvp.statusCode).toBe(200);
    expect(rsvp.json().event.my_answer).toBe("going");
    expect(rsvp.json().event.counts.going).toBe(1);
  });

  it("sets disappearing and privacy", async () => {
    const ttl = await app.inject({
      method: "PUT",
      url: `/api/conversations/${chatId}/disappearing`,
      headers: { authorization: `Bearer ${a.access}` },
      payload: { seconds: 86400 },
    });
    expect(ttl.statusCode).toBe(200);
    expect(ttl.json().disappearing_seconds).toBe(86400);

    const msg = await app.inject({
      method: "POST",
      url: `/api/conversations/${chatId}/messages`,
      headers: { authorization: `Bearer ${a.access}` },
      payload: { text: "vanishes" },
    });
    expect(msg.statusCode).toBe(201);
    expect(msg.json().expires_at).toBeTruthy();

    const privacy = await app.inject({
      method: "PUT",
      url: "/api/me/privacy",
      headers: { authorization: `Bearer ${a.access}` },
      payload: { last_seen: "nobody", online: "nobody" },
    });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.json().last_seen).toBe("nobody");
  });
});
