import { buildApp } from "../src/app.js";
import { prisma } from "../src/db.js";

const app = await buildApp();

async function login(n) {
  await app.inject({
    method: "POST",
    url: "/api/auth/otp/request",
    payload: { country: "92", national_number: n },
  });
  const phone = `+92${n}`;
  const c = await prisma.otpChallenge.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  const v = await app.inject({
    method: "POST",
    url: "/api/auth/otp/verify",
    payload: { phone, code: c.devCode },
  });
  const access = v.json().access;
  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${access}` },
  });
  return { access, userId: me.json().id };
}

const stamp = String(Date.now()).slice(-6);
const a = await login(`901${stamp}`);
const b = await login(`902${stamp}`);
const d = await app.inject({
  method: "POST",
  url: "/api/conversations/direct",
  headers: { authorization: `Bearer ${a.access}` },
  payload: { user_id: b.userId },
});
const id = d.json().id;
const s = await app.inject({
  method: "PUT",
  url: `/api/conversations/${id}/settings`,
  headers: { authorization: `Bearer ${a.access}` },
  payload: { archived: true, pinned: true, muted: true },
});
console.log("status", s.statusCode);
console.log(JSON.stringify(s.json(), null, 2));
await app.close();
await prisma.$disconnect();
