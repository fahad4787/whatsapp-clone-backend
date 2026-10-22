import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { adminAuthRoutes } from "./routes/admin/auth.js";
import { adminOtpRoutes } from "./routes/admin/otps.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
    },
  });

  await app.register(cors, {
    origin: config.corsOrigin.split(",").map((s: string) => s.trim()),
    credentials: true,
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(adminAuthRoutes);
  await app.register(adminOtpRoutes);

  return app;
}
