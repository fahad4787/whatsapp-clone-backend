import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
    },
  });

  await app.register(cors, {
    origin: config.corsOrigin.split(",").map((s) => s.trim()),
    credentials: true,
  });

  await app.register(healthRoutes);

  return app;
}
