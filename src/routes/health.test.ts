import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createHealthRoutes } from "./health.js";

describe("GET /health", () => {
  it("returns 200 when db and redis are up", async () => {
    const app = Fastify({ logger: false });
    await app.register(
      createHealthRoutes({
        pingDb: async () => true,
        pingRedis: async () => true,
      }),
    );

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      service: "aivora-backend",
      db: "up",
      redis: "up",
    });
    await app.close();
  });

  it("returns 503 when db is down", async () => {
    const app = Fastify({ logger: false });
    await app.register(
      createHealthRoutes({
        pingDb: async () => false,
        pingRedis: async () => true,
      }),
    );

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      ok: false,
      db: "down",
      redis: "up",
    });
    await app.close();
  });
});
