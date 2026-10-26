import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { toUserDto } from "../profile.js";
import { requireUser } from "../plugins/auth.js";
import { notifyScheduledCallInvite } from "../push/fcm.js";
import { realtimeHub } from "../realtime/hub.js";
import { createAndRingCall } from "./calls.js";

const scheduledInclude = {
  organizer: true,
  participants: {
    include: {
      user: true,
    },
  },
} as const;

type ScheduledRow = Awaited<
  ReturnType<
    typeof prisma.scheduledCall.findUnique<{
      where: { id: string };
      include: typeof scheduledInclude;
    }>
  >
>;

function endsAt(row: { startsAt: Date; durationMinutes: number }): Date {
  return new Date(row.startsAt.getTime() + row.durationMinutes * 60_000);
}

function toScheduledDto(row: NonNullable<ScheduledRow>, viewerId: string) {
  const mine = row.participants.find((p) => p.userId === viewerId);
  const media = row.media === "VIDEO" ? "video" : "audio";
  return {
    id: row.id,
    title: row.title,
    media,
    audio: media === "audio",
    starts_at: row.startsAt.toISOString(),
    ends_at: endsAt(row).toISOString(),
    duration_minutes: row.durationMinutes,
    reminder_minutes: row.reminderMinutes,
    organizer: toUserDto(row.organizer),
    organizer_id: row.organizerId,
    conversation_id: row.conversationId,
    status: row.status.toLowerCase(),
    my_status: mine?.status.toLowerCase() ?? null,
    scheduled: true,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    participants: row.participants.map((p) => ({
      user_id: p.userId,
      status: p.status.toLowerCase(),
      joined_at: p.respondedAt?.toISOString() ?? null,
      left_at: null,
      ringing: false,
      silenced: false,
      user: toUserDto(p.user),
    })),
  };
}

async function loadScheduled(id: string) {
  return prisma.scheduledCall.findUnique({
    where: { id },
    include: scheduledInclude,
  });
}

function canView(row: NonNullable<ScheduledRow>, userId: string): boolean {
  if (row.organizerId === userId) return true;
  return row.participants.some((p) => p.userId === userId);
}

export async function scheduledCallRoutes(app: FastifyInstance) {
  app.get("/api/scheduled-calls", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const scope = String((req.query as { scope?: string }).scope ?? "upcoming").toLowerCase();
    const now = new Date();

    const rows = await prisma.scheduledCall.findMany({
      where: {
        AND: [
          scope === "past"
            ? {
                OR: [
                  { status: { in: ["COMPLETED", "CANCELLED"] } },
                  { status: "UPCOMING", startsAt: { lt: now } },
                ],
              }
            : { status: "UPCOMING", startsAt: { gte: now } },
          {
            OR: [
              { organizerId: userId },
              { participants: { some: { userId } } },
            ],
          },
        ],
      },
      orderBy: { startsAt: scope === "past" ? "desc" : "asc" },
      take: 100,
      include: scheduledInclude,
    });

    return { items: rows.map((r) => toScheduledDto(r, userId)) };
  });

  app.post("/api/scheduled-calls", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(120),
        media: z.enum(["audio", "video"]).default("audio"),
        starts_at: z.string().datetime(),
        duration_minutes: z.number().int().min(5).max(180).default(30),
        reminder_minutes: z.number().int().min(0).max(1440).default(10),
        conversation_id: z.string().min(1).optional(),
        user_ids: z.array(z.string().min(1)).max(8).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const startsAt = new Date(parsed.data.starts_at);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now() - 60_000) {
      return reply.code(400).send({ error: "invalid_starts_at" });
    }

    let conversationId = parsed.data.conversation_id ?? null;
    let inviteeIds: string[] = [];

    if (conversationId) {
      const membership = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
      });
      if (!membership) {
        return reply.code(403).send({ error: "not_member" });
      }
      const members = await prisma.conversationMember.findMany({
        where: { conversationId },
        select: { userId: true },
      });
      inviteeIds = members.map((m) => m.userId).filter((id) => id !== userId);
    } else if (parsed.data.user_ids?.length) {
      inviteeIds = [...new Set(parsed.data.user_ids)].filter((id) => id !== userId);
    } else {
      return reply.code(400).send({ error: "conversation_or_users_required" });
    }

    if (inviteeIds.length === 0) {
      return reply.code(400).send({ error: "no_invitees" });
    }
    if (inviteeIds.length > 8) {
      return reply.code(400).send({ error: "too_many_invitees" });
    }

    const existing = await prisma.user.count({
      where: { id: { in: inviteeIds }, bannedAt: null },
    });
    if (existing !== inviteeIds.length) {
      return reply.code(400).send({ error: "unknown_users" });
    }

    const created = await prisma.scheduledCall.create({
      data: {
        title: parsed.data.title,
        media: parsed.data.media === "video" ? "VIDEO" : "AUDIO",
        startsAt,
        durationMinutes: parsed.data.duration_minutes,
        reminderMinutes: parsed.data.reminder_minutes,
        organizerId: userId,
        conversationId,
        status: "UPCOMING",
        participants: {
          create: [
            { userId, status: "ACCEPTED", respondedAt: new Date() },
            ...inviteeIds.map((id) => ({ userId: id, status: "PENDING" as const })),
          ],
        },
      },
    });

    const full = await loadScheduled(created.id);
    if (!full) {
      return reply.code(500).send({ error: "create_failed" });
    }

    const dto = toScheduledDto(full, userId);
    for (const inviteeId of inviteeIds) {
      realtimeHub.toUser(inviteeId, {
        type: "scheduled_call.invite",
        data: toScheduledDto(full, inviteeId),
      });
    }
    void notifyScheduledCallInvite({
      inviteeIds,
      title: full.title,
      organizerName: full.organizer.displayName || full.organizer.phone || "Aivora",
      scheduledCallId: full.id,
      startsAt: full.startsAt.toISOString(),
    }).catch(() => undefined);

    req.log.info(
      { scheduledCallId: full.id, invitees: inviteeIds.length, media: full.media },
      "scheduled_call.created",
    );
    return reply.code(201).send(dto);
  });

  app.get("/api/scheduled-calls/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const id = (req.params as { id: string }).id;
    const row = await loadScheduled(id);
    if (!row || !canView(row, userId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    return toScheduledDto(row, userId);
  });

  app.put("/api/scheduled-calls/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const id = (req.params as { id: string }).id;
    const row = await loadScheduled(id);
    if (!row || row.organizerId !== userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (row.status !== "UPCOMING") {
      return reply.code(400).send({ error: "not_upcoming" });
    }

    const parsed = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        media: z.enum(["audio", "video"]).optional(),
        starts_at: z.string().datetime().optional(),
        duration_minutes: z.number().int().min(5).max(180).optional(),
        reminder_minutes: z.number().int().min(0).max(1440).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    let startsAt: Date | undefined;
    if (parsed.data.starts_at) {
      startsAt = new Date(parsed.data.starts_at);
      if (Number.isNaN(startsAt.getTime())) {
        return reply.code(400).send({ error: "invalid_starts_at" });
      }
    }

    await prisma.scheduledCall.update({
      where: { id },
      data: {
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.media
          ? { media: parsed.data.media === "video" ? "VIDEO" : "AUDIO" }
          : {}),
        ...(startsAt ? { startsAt } : {}),
        ...(parsed.data.duration_minutes != null
          ? { durationMinutes: parsed.data.duration_minutes }
          : {}),
        ...(parsed.data.reminder_minutes != null
          ? { reminderMinutes: parsed.data.reminder_minutes }
          : {}),
      },
    });

    const full = await loadScheduled(id);
    return toScheduledDto(full!, userId);
  });

  app.delete("/api/scheduled-calls/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const id = (req.params as { id: string }).id;
    const row = await loadScheduled(id);
    if (!row || row.organizerId !== userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (row.status !== "UPCOMING") {
      return reply.code(400).send({ error: "not_upcoming" });
    }

    await prisma.scheduledCall.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
    const full = await loadScheduled(id);
    for (const p of full!.participants) {
      if (p.userId === userId) continue;
      realtimeHub.toUser(p.userId, {
        type: "scheduled_call.cancelled",
        data: toScheduledDto(full!, p.userId),
      });
    }
    return toScheduledDto(full!, userId);
  });

  app.post("/api/scheduled-calls/:id/respond", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const id = (req.params as { id: string }).id;
    const parsed = z
      .object({ action: z.enum(["accept", "decline"]) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const row = await loadScheduled(id);
    if (!row || !canView(row, userId) || row.organizerId === userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (row.status !== "UPCOMING") {
      return reply.code(400).send({ error: "not_upcoming" });
    }

    const status = parsed.data.action === "accept" ? "ACCEPTED" : "DECLINED";
    await prisma.scheduledCallParticipant.update({
      where: { scheduledCallId_userId: { scheduledCallId: id, userId } },
      data: { status, respondedAt: new Date() },
    });

    const full = await loadScheduled(id);
    realtimeHub.toUser(row.organizerId, {
      type: "scheduled_call.respond",
      data: toScheduledDto(full!, row.organizerId),
    });
    return toScheduledDto(full!, userId);
  });

  app.post("/api/scheduled-calls/:id/start", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const id = (req.params as { id: string }).id;
    const row = await loadScheduled(id);
    if (!row || !canView(row, userId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (row.status !== "UPCOMING") {
      return reply.code(400).send({ error: "not_upcoming" });
    }

    const accepted = row.participants
      .filter((p) => p.userId !== userId && p.status !== "DECLINED")
      .map((p) => p.userId);
    const calleeIds =
      accepted.length > 0
        ? accepted
        : row.participants.filter((p) => p.userId !== userId).map((p) => p.userId);

    const started = await createAndRingCall({
      userId,
      conversationId: row.conversationId,
      calleeIds,
      media: row.media === "VIDEO" ? "video" : "audio",
    });
    if (!started.ok) {
      return reply.code(started.code).send({ error: started.error });
    }

    await prisma.scheduledCall.update({
      where: { id },
      data: { status: "COMPLETED" },
    });

    req.log.info(
      { scheduledCallId: id, callId: started.result.call.id, callees: calleeIds.length },
      "scheduled_call.started",
    );
    return reply.code(201).send(started.result);
  });
}
