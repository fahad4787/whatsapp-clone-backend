import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  updateAppSettings,
} from "../../services/appConfig.js";

const patchSchema = z
  .object({
    otp_length: z.number().int().min(4).max(8).optional(),
    otp_expiry: z.number().int().min(60).max(1800).optional(),
    otp_attempts: z.number().int().min(1).max(10).optional(),
    otp_gap: z.number().int().min(10).max(600).optional(),
    otp_per_phone_hourly: z.number().int().min(1).max(50).optional(),
    otp_per_ip_hourly: z.number().int().min(1).max(5000).optional(),
    ring_timeout: z.number().int().min(15).max(120).optional(),
    max_group_call_participants: z.number().int().min(2).max(100).optional(),
    max_group_size: z.number().int().min(2).max(1024).optional(),
    upload_limit_mb: z.number().int().min(1).max(2048).optional(),
    edit_window_minutes: z.number().int().min(0).max(1440).optional(),
    maintenance_mode: z.boolean().optional(),
    latest_android_version: z.string().trim().min(1).max(40).optional(),
    latest_android_version_code: z.number().int().min(1).optional(),
    min_android_version_code: z.number().int().min(1).optional(),
    download_url: z.string().trim().url().max(500).optional(),
    allow_people_search: z.boolean().optional(),
    min_search_chars: z.number().int().min(1).max(20).optional(),
    sms_enabled: z.boolean().optional(),
  })
  .strict();

export async function adminSettingsRoutes(app: FastifyInstance) {
  app.get("/api/admin/settings", { preHandler: requireAdmin }, async () => {
    const settings = await getAppSettings();
    return { settings, defaults: DEFAULT_APP_SETTINGS };
  });

  app.put("/api/admin/settings", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const settings = await updateAppSettings(parsed.data);
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "settings.update",
        meta: { keys: Object.keys(parsed.data) },
      },
    });
    return { settings };
  });
}
