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
}) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    has_push_token: Boolean(d.pushToken),
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

export async function deviceRoutes(app: FastifyInstance) {
  app.get("/api/me/devices", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const rows = await prisma.device.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
    return { items: rows.map(toDeviceDto) };
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

    return toDeviceDto(device);
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
}
