import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";
import { ensureCountriesSeeded, listCountries } from "../../services/appConfig.js";

export async function adminCountryRoutes(app: FastifyInstance) {
  app.get("/api/admin/countries", { preHandler: requireAdmin }, async () => {
    const items = await listCountries();
    return {
      items: items.map((c) => ({
        iso: c.iso,
        name: c.name,
        dial: c.dial,
        enabled: c.enabled,
        sort_order: c.sortOrder,
      })),
    };
  });

  app.put("/api/admin/countries/:iso", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    await ensureCountriesSeeded();
    const { iso } = req.params as { iso: string };
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        name: z.string().trim().min(1).max(80).optional(),
        dial: z.string().trim().min(1).max(8).optional(),
        sort_order: z.number().int().min(0).max(9999).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const existing = await prisma.country.findUnique({ where: { iso: iso.toUpperCase() } });
    if (!existing) {
      return reply.code(404).send({ error: "not_found" });
    }
    const updated = await prisma.country.update({
      where: { iso: existing.iso },
      data: {
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.dial !== undefined ? { dial: parsed.data.dial } : {}),
        ...(parsed.data.sort_order !== undefined ? { sortOrder: parsed.data.sort_order } : {}),
      },
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "country.update",
        meta: { iso: updated.iso, enabled: updated.enabled },
      },
    });
    return {
      iso: updated.iso,
      name: updated.name,
      dial: updated.dial,
      enabled: updated.enabled,
      sort_order: updated.sortOrder,
    };
  });
}
