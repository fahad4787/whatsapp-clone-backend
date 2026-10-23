import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";

export async function adminMetricsRoutes(app: FastifyInstance) {
  app.get("/api/admin/metrics", { preHandler: requireAdmin }, async () => {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      usersTotal,
      usersBanned,
      signupsToday,
      messagesToday,
      messagesLast7d,
      reportsOpen,
      conversationsTotal,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { bannedAt: { not: null } } }),
      prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.message.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.message.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.report.count({ where: { status: "OPEN" } }),
      prisma.conversation.count(),
    ]);

    return {
      users_total: usersTotal,
      users_banned: usersBanned,
      signups_today: signupsToday,
      messages_today: messagesToday,
      messages_last_7d: messagesLast7d,
      reports_open: reportsOpen,
      conversations_total: conversationsTotal,
    };
  });
}
