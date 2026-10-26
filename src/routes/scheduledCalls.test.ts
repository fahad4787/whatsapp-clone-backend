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

describe("Wave 16.3 scheduled calls", () => {
  it("creates, lists, responds, and cancels a scheduled call", async () => {
    const suffix = String(Date.now()).slice(-8);
    const a = await userAccess(`920${suffix}`.slice(0, 10));
    const b = await userAccess(`921${suffix}`.slice(0, 10));

    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    const create = await app.inject({
      method: "POST",
      url: "/api/scheduled-calls",
      headers: { authorization: `Bearer ${a.access}` },
      payload: {
        title: "Weekend catch-up",
        media: "video",
        starts_at: startsAt,
        duration_minutes: 30,
        reminder_minutes: 10,
        user_ids: [b.userId],
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as {
      id: string;
      status: string;
      my_status: string;
      title: string;
    };
    expect(created.title).toBe("Weekend catch-up");
    expect(created.status).toBe("upcoming");
    expect(created.my_status).toBe("accepted");

    const listA = await app.inject({
      method: "GET",
      url: "/api/scheduled-calls?scope=upcoming",
      headers: { authorization: `Bearer ${a.access}` },
    });
    expect(listA.statusCode).toBe(200);
    expect((listA.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const listB = await app.inject({
      method: "GET",
      url: "/api/scheduled-calls?scope=upcoming",
      headers: { authorization: `Bearer ${b.access}` },
    });
    expect(listB.statusCode).toBe(200);
    const bItems = (listB.json() as { items: { id: string; my_status: string }[] }).items;
    expect(bItems.some((i) => i.id === created.id)).toBe(true);

    const respond = await app.inject({
      method: "POST",
      url: `/api/scheduled-calls/${created.id}/respond`,
      headers: { authorization: `Bearer ${b.access}` },
      payload: { action: "accept" },
    });
    expect(respond.statusCode).toBe(200);
    expect((respond.json() as { my_status: string }).my_status).toBe("accepted");

    const cancel = await app.inject({
      method: "DELETE",
      url: `/api/scheduled-calls/${created.id}`,
      headers: { authorization: `Bearer ${a.access}` },
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { status: string }).status).toBe("cancelled");

    const past = await app.inject({
      method: "GET",
      url: "/api/scheduled-calls?scope=past",
      headers: { authorization: `Bearer ${a.access}` },
    });
    expect(past.statusCode).toBe(200);
    const pastItems = (past.json() as { items: { id: string }[] }).items;
    expect(pastItems.some((i) => i.id === created.id)).toBe(true);
  });
});
