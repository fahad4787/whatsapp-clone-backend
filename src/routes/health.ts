import type { FastifyInstance } from "fastify";
import { pingDb } from "../db.js";
import { pingRedis } from "../redis.js";

export type HealthDeps = {
  pingDb: () => Promise<boolean>;
  pingRedis: () => Promise<boolean>;
};

const defaultDeps: HealthDeps = {
  pingDb,
  pingRedis,
};

export function createHealthRoutes(deps: HealthDeps = defaultDeps) {
  return async function healthRoutes(app: FastifyInstance) {
    app.get("/health", async (_req, reply) => {
      const [db, redis] = await Promise.all([deps.pingDb(), deps.pingRedis()]);
      const ok = db && redis;
      const body = {
        ok,
        service: "aivora-backend",
        db: db ? "up" : "down",
        redis: redis ? "up" : "down",
        ts: new Date().toISOString(),
      };
      return reply.code(ok ? 200 : 503).send(body);
    });
  };
}

export const healthRoutes = createHealthRoutes();
