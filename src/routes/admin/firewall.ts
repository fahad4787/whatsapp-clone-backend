import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  getAdminIpAllowlist,
  normalizeClientIp,
  setAdminIpAllowlist,
} from "../../services/firewall.js";

export async function adminFirewallRoutes(app: FastifyInstance) {
  app.get("/api/admin/firewall", { preHandler: requireAdmin }, async (req) => {
    const allowlist = await getAdminIpAllowlist();
    return {
      allowlist,
      client_ip: normalizeClientIp(req.ip) ?? req.ip ?? null,
    };
  });

  app.put("/api/admin/firewall", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const parsed = z
      .object({
        allowlist: z.array(z.string().trim().min(1).max(64)).max(200),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const allowlist = await setAdminIpAllowlist(parsed.data.allowlist);
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "firewall.update",
        meta: { count: allowlist.length },
      },
    });
    return {
      allowlist,
      client_ip: normalizeClientIp(req.ip) ?? req.ip ?? null,
    };
  });
}
