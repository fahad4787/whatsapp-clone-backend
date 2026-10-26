import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";
import { realtimeHub } from "../../realtime/hub.js";

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
      groupsTotal,
      directTotal,
      disappearingChats,
      mediaToday,
      pollsToday,
      eventsToday,
      voiceToday,
      activeCalls,
      callsToday,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { bannedAt: { not: null } } }),
      prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.message.count({ where: { createdAt: { gte: startOfToday } } }),
      prisma.message.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.report.count({ where: { status: "OPEN" } }),
      prisma.conversation.count(),
      prisma.conversation.count({ where: { type: "GROUP" } }),
      prisma.conversation.count({ where: { type: "DIRECT" } }),
      prisma.conversation.count({ where: { disappearingSeconds: { gt: 0 } } }),
      prisma.message.count({
        where: {
          createdAt: { gte: startOfToday },
          type: { in: ["IMAGE", "VIDEO", "FILE", "AUDIO"] },
        },
      }),
      prisma.message.count({
        where: { createdAt: { gte: startOfToday }, type: "POLL" },
      }),
      prisma.message.count({
        where: { createdAt: { gte: startOfToday }, type: "EVENT" },
      }),
      prisma.message.count({
        where: { createdAt: { gte: startOfToday }, type: "AUDIO" },
      }),
      prisma.call.count({ where: { status: { in: ["RINGING", "ACTIVE"] } } }),
      prisma.call.count({ where: { startedAt: { gte: startOfToday } } }),
    ]);

    // Distinct users with an open WebSocket on this instance.
    const onlineUsers = realtimeHub.onlineUserCount();

    return {
      users_total: usersTotal,
      users_banned: usersBanned,
      users_online: onlineUsers,
      signups_today: signupsToday,
      messages_today: messagesToday,
      messages_last_7d: messagesLast7d,
      messages_media_today: mediaToday,
      messages_voice_today: voiceToday,
      messages_polls_today: pollsToday,
      messages_events_today: eventsToday,
      reports_open: reportsOpen,
      conversations_total: conversationsTotal,
      conversations_groups: groupsTotal,
      conversations_direct: directTotal,
      conversations_disappearing: disappearingChats,
      calls_active: activeCalls,
      calls_today: callsToday,
    };
  });
}
