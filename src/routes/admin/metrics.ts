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

  /**
   * Daily counts (UTC days) for the dashboard trend charts. Read-only.
   * `days` is the window length. The response holds 2 × days *complete* UTC days ending
   * yesterday (today is still filling up), oldest first: the current window plus the one
   * before it, so the client can compare periods without any partial day skewing them.
   */
  app.get("/api/admin/metrics/series", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { days?: string };
    const days = Math.min(90, Math.max(7, Math.trunc(Number(q.days ?? 30)) || 30));
    const total = days * 2;
    const end = new Date(); // exclusive: today 00:00 UTC
    end.setUTCHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - total);
    // Columns are timestamp(3) holding UTC. Bind the bounds as plain timestamps so the comparison
    // doesn't depend on the database session's TimeZone setting.
    const [from, to] = [start, end].map((d) => d.toISOString().slice(0, 23).replace("T", " "));

    type Row = { day: Date; n: bigint };
    const [signups, messages, calls] = await Promise.all([
      prisma.$queryRaw<Row[]>`SELECT date_trunc('day', "createdAt") AS day, count(*) AS n
        FROM "User" WHERE "createdAt" >= ${from}::timestamp AND "createdAt" < ${to}::timestamp GROUP BY 1`,
      prisma.$queryRaw<Row[]>`SELECT date_trunc('day', "createdAt") AS day, count(*) AS n
        FROM "Message" WHERE "createdAt" >= ${from}::timestamp AND "createdAt" < ${to}::timestamp GROUP BY 1`,
      prisma.$queryRaw<Row[]>`SELECT date_trunc('day', "startedAt") AS day, count(*) AS n
        FROM "Call" WHERE "startedAt" >= ${from}::timestamp AND "startedAt" < ${to}::timestamp GROUP BY 1`,
    ]);

    const key = (d: Date) => d.toISOString().slice(0, 10);
    const index = (rows: Row[]) => new Map(rows.map((r) => [key(new Date(r.day)), Number(r.n)]));
    const [s, m, c] = [index(signups), index(messages), index(calls)];

    const points = Array.from({ length: total }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const k = key(d);
      return { date: k, signups: s.get(k) ?? 0, messages: m.get(k) ?? 0, calls: c.get(k) ?? 0 };
    });

    return { days, points };
  });
}
