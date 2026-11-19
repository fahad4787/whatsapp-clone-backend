import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";
import { getLegalDocs, setLegalDocs } from "../../services/legal.js";

export async function adminLegalRoutes(app: FastifyInstance) {
  app.get("/api/admin/legal", { preHandler: requireAdmin }, async () => {
    return getLegalDocs();
  });

  app.put("/api/admin/legal", { preHandler: requireAdmin }, async (req, reply) => {
    const adminId = (req as typeof req & { adminId: string }).adminId;
    const parsed = z
      .object({
        privacy_policy: z.string().max(50_000),
        terms_of_service: z.string().max(50_000),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const docs = await setLegalDocs({
      privacy_policy: parsed.data.privacy_policy.trim() || "Privacy policy",
      terms_of_service: parsed.data.terms_of_service.trim() || "Terms of service",
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "legal.update",
        meta: {
          privacy_len: docs.privacy_policy.length,
          terms_len: docs.terms_of_service.length,
        },
      },
    });
    return docs;
  });
}
