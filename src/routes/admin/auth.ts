import type { FastifyInstance } from "fastify";
import { Secret, TOTP } from "otpauth";
import { z } from "zod";
import { verifyPassword } from "../../auth/crypto.js";
import {
  bearerFromHeader,
  signAdminToken,
  signAdminTotpTicket,
  verifyAdminTotpTicket,
} from "../../auth/jwt.js";
import { prisma } from "../../db.js";
import {
  clearAdminLoginFailures,
  getAdminSecurity,
  isAdminLoginLocked,
  recordAdminLoginFailure,
} from "../../services/adminSecurity.js";
import { isAdminIpAllowed, normalizeClientIp } from "../../services/firewall.js";

function totpFor(secret: string, email: string): TOTP {
  return new TOTP({
    issuer: "Aivora Admin",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

function adminPayload(admin: { id: string; email: string; displayName: string | null; role: string }, hours: number) {
  return {
    access: signAdminToken(admin.id, admin.role, hours),
    admin: {
      id: admin.id,
      email: admin.email,
      display_name: admin.displayName,
      role: admin.role,
    },
  };
}

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post("/api/admin/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const allowed = await isAdminIpAllowed(req.ip);
    if (!allowed) {
      return reply.code(403).send({
        error: "ip_blocked",
        client_ip: normalizeClientIp(req.ip) ?? req.ip ?? null,
      });
    }

    const email = parsed.data.email.toLowerCase();
    if (await isAdminLoginLocked(email)) {
      return reply.code(423).send({ error: "login_locked" });
    }

    const admin = await prisma.adminUser.findUnique({
      where: { email },
    });
    if (!admin) {
      await recordAdminLoginFailure(email);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const ok = await verifyPassword(parsed.data.password, admin.passwordHash);
    if (!ok) {
      await recordAdminLoginFailure(email);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    clearAdminLoginFailures(email);
    const security = await getAdminSecurity();

    if (security.require_2fa) {
      if (!admin.totpSecret || !admin.totpEnabledAt) {
        return {
          status: "totp_enrollment_required",
          ticket: signAdminTotpTicket(admin.id, admin.role, "enroll"),
        };
      }
      return {
        status: "totp_required",
        ticket: signAdminTotpTicket(admin.id, admin.role, "login"),
      };
    }

    await prisma.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: "admin.login",
        meta: {
          email: admin.email,
          ip: normalizeClientIp(req.ip) ?? req.ip ?? null,
        },
      },
    });

    return adminPayload(admin, security.session_hours);
  });

  app.post("/api/admin/auth/totp", async (req, reply) => {
    const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const raw = bearerFromHeader(req.headers.authorization);
    if (!raw) return reply.code(401).send({ error: "unauthorized" });
    let ticket: ReturnType<typeof verifyAdminTotpTicket>;
    try {
      ticket = verifyAdminTotpTicket(raw);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (ticket.purpose !== "login") {
      return reply.code(400).send({ error: "wrong_ticket" });
    }
    const admin = await prisma.adminUser.findUnique({ where: { id: ticket.sub } });
    if (!admin?.totpSecret || !admin.totpEnabledAt) {
      return reply.code(401).send({ error: "totp_not_enrolled" });
    }
    const delta = totpFor(admin.totpSecret, admin.email).validate({ token: parsed.data.code, window: 1 });
    if (delta === null) return reply.code(401).send({ error: "invalid_code" });
    const security = await getAdminSecurity();
    await prisma.adminAuditLog.create({
      data: { actorId: admin.id, action: "admin.login", meta: { totp: true } },
    });
    return adminPayload(admin, security.session_hours);
  });

  app.post("/api/admin/auth/totp/setup", async (req, reply) => {
    const raw = bearerFromHeader(req.headers.authorization);
    if (!raw) return reply.code(401).send({ error: "unauthorized" });
    let ticket: ReturnType<typeof verifyAdminTotpTicket>;
    try {
      ticket = verifyAdminTotpTicket(raw);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (ticket.purpose !== "enroll") return reply.code(400).send({ error: "wrong_ticket" });
    const admin = await prisma.adminUser.findUnique({ where: { id: ticket.sub } });
    if (!admin) return reply.code(401).send({ error: "unauthorized" });
    const secret = new Secret({ size: 20 }).base32;
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { totpSecret: secret, totpEnabledAt: null },
    });
    const uri = totpFor(secret, admin.email).toString();
    return { secret, otpauth_uri: uri };
  });

  app.post("/api/admin/auth/totp/confirm", async (req, reply) => {
    const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const raw = bearerFromHeader(req.headers.authorization);
    if (!raw) return reply.code(401).send({ error: "unauthorized" });
    let ticket: ReturnType<typeof verifyAdminTotpTicket>;
    try {
      ticket = verifyAdminTotpTicket(raw);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (ticket.purpose !== "enroll") return reply.code(400).send({ error: "wrong_ticket" });
    const admin = await prisma.adminUser.findUnique({ where: { id: ticket.sub } });
    if (!admin?.totpSecret) return reply.code(400).send({ error: "setup_first" });
    const delta = totpFor(admin.totpSecret, admin.email).validate({ token: parsed.data.code, window: 1 });
    if (delta === null) return reply.code(401).send({ error: "invalid_code" });
    const updated = await prisma.adminUser.update({
      where: { id: admin.id },
      data: { totpEnabledAt: new Date() },
    });
    const security = await getAdminSecurity();
    return adminPayload(updated, security.session_hours);
  });
}
