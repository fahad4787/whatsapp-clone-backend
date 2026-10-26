import { mkdirSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { adminAuthRoutes } from "./routes/admin/auth.js";
import { adminOtpRoutes } from "./routes/admin/otps.js";
import { adminUserRoutes } from "./routes/admin/users.js";
import { adminReportRoutes } from "./routes/admin/reports.js";
import { adminMetricsRoutes } from "./routes/admin/metrics.js";
import { adminConversationRoutes } from "./routes/admin/conversations.js";
import { adminCallRoutes } from "./routes/admin/calls.js";
import { conversationRoutes } from "./routes/conversations.js";
import { messageRoutes } from "./routes/messages.js";
import { mediaRoutes } from "./routes/media.js";
import { deviceRoutes } from "./routes/devices.js";
import { peopleRoutes } from "./routes/people.js";
import { reportRoutes } from "./routes/reports.js";
import { blockRoutes } from "./routes/blocks.js";
import { callRoutes } from "./routes/calls.js";
import { scheduledCallRoutes } from "./routes/scheduledCalls.js";
import { wsRoutes } from "./routes/ws.js";
import { initFcm } from "./push/fcm.js";

const uploadsRoot = path.join(process.cwd(), "uploads");
mkdirSync(path.join(uploadsRoot, "avatars"), { recursive: true });
mkdirSync(path.join(uploadsRoot, "group-avatars"), { recursive: true });
mkdirSync(path.join(uploadsRoot, "media"), { recursive: true });

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
    },
  });

  await app.register(cors, {
    origin: config.corsOrigin.split(",").map((s: string) => s.trim()),
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 1,
    },
  });

  await app.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: "/uploads/",
    decorateReply: false,
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(adminAuthRoutes);
  await app.register(adminOtpRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminReportRoutes);
  await app.register(adminMetricsRoutes);
  await app.register(adminConversationRoutes);
  await app.register(adminCallRoutes);
  await app.register(conversationRoutes);
  await app.register(messageRoutes);
  await app.register(mediaRoutes);
  await app.register(deviceRoutes);
  await app.register(peopleRoutes);
  await app.register(reportRoutes);
  await app.register(blockRoutes);
  await app.register(callRoutes);
  await app.register(scheduledCallRoutes);
  await app.register(wsRoutes);

  initFcm();

  return app;
}
