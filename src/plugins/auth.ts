import type { FastifyReply, FastifyRequest } from "fastify";
import { bearerFromHeader, verifyAccessToken, verifyAdminToken } from "../auth/jwt.js";

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  try {
    const claims = verifyAccessToken(token);
    (req as FastifyRequest & { userId: string }).userId = claims.sub;
  } catch {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  try {
    const claims = verifyAdminToken(token);
    (req as FastifyRequest & { adminId: string; adminRole: string }).adminId = claims.sub;
    (req as FastifyRequest & { adminId: string; adminRole: string }).adminRole = claims.role;
  } catch {
    return reply.code(401).send({ error: "unauthorized" });
  }
}
