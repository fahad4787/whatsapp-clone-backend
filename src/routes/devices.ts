import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";

function toDeviceDto(d: {
  id: string;
  name: string | null;
  platform: string | null;
  pushToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}, isCurrent = false) {
  return {
    id: d.id,
    platform: d.platform,
    device_name: d.name,
    last_active_at: d.updatedAt.toISOString(),
    created_at: d.createdAt.toISOString(),
    is_current: isCurrent,
    has_push_token: Boolean(d.pushToken),
  };
}

export async function deviceRoutes(app: FastifyInstance) {
  app.get("/api/me/devices", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const rows = await prisma.device.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    const latestId = rows[0]?.id;
    return { items: rows.map((d) => toDeviceDto(d, d.id === latestId)) };
  });

  /** Register / refresh FCM token on the current user's latest (or new) device. */
  app.put("/api/me/push-token", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        push_token: z.string().min(10).max(4096),
        platform: z.string().max(40).optional(),
        device_name: z.string().max(120).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    // One token → one device row
    await prisma.device.updateMany({
      where: {
        pushToken: parsed.data.push_token,
        userId: { not: userId },
      },
      data: { pushToken: null },
    });

    const latest = await prisma.device.findFirst({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });

    const device = latest
      ? await prisma.device.update({
          where: { id: latest.id },
          data: {
            pushToken: parsed.data.push_token,
            platform: parsed.data.platform ?? latest.platform ?? "android",
            name: parsed.data.device_name ?? latest.name,
          },
        })
      : await prisma.device.create({
          data: {
            userId,
            pushToken: parsed.data.push_token,
            platform: parsed.data.platform ?? "android",
            name: parsed.data.device_name,
          },
        });

    return toDeviceDto(device, true);
  });

  app.patch("/api/me/devices/:id/push-token", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ push_token: z.string().min(10).max(4096).nullable() })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const existing = await prisma.device.findFirst({ where: { id, userId } });
    if (!existing) {
      return reply.code(404).send({ error: "not_found" });
    }

    const device = await prisma.device.update({
      where: { id },
      data: { pushToken: parsed.data.push_token },
    });
    return toDeviceDto(device);
  });

  app.delete("/api/me/devices/:id/push-token", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const existing = await prisma.device.findFirst({ where: { id, userId } });
    if (!existing) {
      return reply.code(404).send({ error: "not_found" });
    }
    const device = await prisma.device.update({
      where: { id },
      data: { pushToken: null },
    });
    return toDeviceDto(device);
  });

  /** Revoke a linked device: clear push, revoke refresh tokens tied to it, delete row. */
  app.delete("/api/me/devices/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const existing = await prisma.device.findFirst({ where: { id, userId } });
    if (!existing) {
      return reply.code(404).send({ error: "not_found" });
    }

    await prisma.refreshToken.updateMany({
      where: { userId, deviceId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.device.delete({ where: { id } });
    return reply.code(204).send();
  });
}
