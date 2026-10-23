import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../plugins/auth.js";
import { toUserDto } from "../profile.js";

export async function blockRoutes(app: FastifyInstance) {
  app.get("/api/blocks", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const rows = await prisma.block.findMany({
      where: { blockerId: userId },
      orderBy: { createdAt: "desc" },
      include: { blocked: true },
    });
    return {
      items: rows.map((r) => ({
        id: r.blockedId,
        user: toUserDto(r.blocked),
        created_at: r.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/blocks", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z.object({ user_id: z.string().min(1) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const blockedId = parsed.data.user_id;
    if (blockedId === userId) {
      return reply.code(400).send({ error: "cannot_block_self" });
    }
    const target = await prisma.user.findUnique({ where: { id: blockedId } });
    if (!target) {
      return reply.code(404).send({ error: "user_not_found" });
    }

    const row = await prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId: userId, blockedId } },
      create: { blockerId: userId, blockedId },
      update: {},
      include: { blocked: true },
    });
    return reply.code(201).send({
      id: row.blockedId,
      user: toUserDto(row.blocked),
      created_at: row.createdAt.toISOString(),
    });
  });

  app.delete("/api/blocks/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const result = await prisma.block.deleteMany({
      where: { blockerId: userId, blockedId: id },
    });
    if (result.count === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { ok: true };
  });
}
