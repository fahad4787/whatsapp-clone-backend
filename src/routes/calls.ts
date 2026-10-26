import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { livekitConfigured, livekitUrl, mintLivekitToken } from "../livekit.js";
import { requireUser } from "../plugins/auth.js";
import { realtimeHub } from "../realtime/hub.js";

const RING_TTL_MS = 60_000;

type CallRow = Awaited<ReturnType<typeof loadCall>>;

async function loadCall(id: string) {
  return prisma.call.findUnique({
    where: { id },
    include: {
      initiator: { select: { id: true, phone: true, displayName: true, avatarUrl: true } },
      participants: {
        include: {
          user: { select: { id: true, phone: true, displayName: true, avatarUrl: true } },
        },
      },
      conversation: { select: { id: true, type: true, title: true } },
    },
  });
}

function durationSeconds(call: { answeredAt: Date | null; endedAt: Date | null }): number {
  if (!call.answeredAt || !call.endedAt) return 0;
  return Math.max(0, Math.round((call.endedAt.getTime() - call.answeredAt.getTime()) / 1000));
}

function toCallDto(call: NonNullable<CallRow>) {
  return {
    id: call.id,
    kind: call.kind,
    media: call.media.toLowerCase(),
    conversation_id: call.conversationId,
    initiator_id: call.initiatorId,
    room_name: call.roomName,
    status: call.status.toLowerCase(),
    end_reason: call.endReason,
    drop_in: false,
    started_at: call.startedAt.toISOString(),
    answered_at: call.answeredAt?.toISOString() ?? null,
    ended_at: call.endedAt?.toISOString() ?? null,
    duration_seconds: durationSeconds(call),
    expires_at: call.expiresAt?.toISOString() ?? null,
    group_title:
      call.conversation?.type === "GROUP" ? call.conversation.title ?? "Group" : null,
    caller: {
      id: call.initiator.id,
      name: call.initiator.displayName || call.initiator.phone,
      avatar_url: call.initiator.avatarUrl,
    },
    participants: call.participants.map((p) => ({
      user_id: p.userId,
      status: p.status.toLowerCase(),
      joined_at: p.joinedAt?.toISOString() ?? null,
      left_at: p.leftAt?.toISOString() ?? null,
      ringing: p.status === "RINGING",
      silenced: false,
      user: {
        id: p.user.id,
        phone: p.user.phone,
        display_name: p.user.displayName,
        avatar_url: p.user.avatarUrl,
      },
    })),
  };
}

async function tokenFor(userId: string, call: NonNullable<CallRow>, displayName?: string | null) {
  const token = await mintLivekitToken({
    roomName: call.roomName,
    identity: userId,
    name: displayName ?? undefined,
  });
  return {
    call: toCallDto(call),
    token,
    livekit_url: livekitUrl(),
    invited: false,
  };
}

function notifyParticipants(
  call: NonNullable<CallRow>,
  type: string,
  exceptUserId?: string,
  extra?: Record<string, unknown>,
) {
  const payload = { ...toCallDto(call), ...extra };
  for (const p of call.participants) {
    if (exceptUserId && p.userId === exceptUserId) continue;
    realtimeHub.toUser(p.userId, { type, data: payload });
  }
}

export async function callRoutes(app: FastifyInstance) {
  app.post("/api/calls", { preHandler: requireUser }, async (req, reply) => {
    if (!livekitConfigured()) {
      return reply.code(503).send({ error: "livekit_not_configured" });
    }
    const userId = (req as typeof req & { userId: string }).userId;
    const parsed = z
      .object({
        conversation_id: z.string().min(1).optional(),
        media: z.enum(["audio", "video"]).default("audio"),
        user_ids: z.array(z.string().min(1)).max(8).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    let conversationId = parsed.data.conversation_id ?? null;
    let calleeIds: string[] = [];

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
      calleeIds = members.map((m) => m.userId).filter((id) => id !== userId);
    } else if (parsed.data.user_ids?.length) {
      calleeIds = [...new Set(parsed.data.user_ids)].filter((id) => id !== userId);
      if (calleeIds.length === 0) {
        return reply.code(400).send({ error: "no_callees" });
      }
    } else {
      return reply.code(400).send({ error: "conversation_or_users_required" });
    }

    if (calleeIds.length === 0) {
      return reply.code(400).send({ error: "no_callees" });
    }

    // Blocked either way → refuse.
    const blocks = await prisma.block.findMany({
      where: {
        OR: [
          { blockerId: userId, blockedId: { in: calleeIds } },
          { blockerId: { in: calleeIds }, blockedId: userId },
        ],
      },
    });
    if (blocks.length > 0) {
      return reply.code(403).send({ error: "blocked" });
    }

    const me = await prisma.user.findUnique({ where: { id: userId } });
    const roomName = `call_${randomUUID().replace(/-/g, "")}`;
    const media = parsed.data.media === "video" ? "VIDEO" : "AUDIO";
    const expiresAt = new Date(Date.now() + RING_TTL_MS);

    const call = await prisma.call.create({
      data: {
        kind: calleeIds.length > 1 ? "group" : "direct",
        media,
        conversationId,
        initiatorId: userId,
        roomName,
        status: "RINGING",
        expiresAt,
        participants: {
          create: [
            { userId, status: "JOINED", joinedAt: new Date() },
            ...calleeIds.map((id) => ({ userId: id, status: "RINGING" as const })),
          ],
        },
      },
    });

    const full = await loadCall(call.id);
    if (!full) {
      return reply.code(500).send({ error: "create_failed" });
    }

    for (const calleeId of calleeIds) {
      realtimeHub.toUser(calleeId, {
        type: "call.incoming",
        data: toCallDto(full),
      });
    }

    // Auto-miss if nobody answers.
    setTimeout(() => {
      void (async () => {
        const current = await prisma.call.findUnique({ where: { id: call.id } });
        if (!current || current.status !== "RINGING") return;
        const ended = await prisma.call.update({
          where: { id: call.id },
          data: {
            status: "MISSED",
            endReason: "timeout",
            endedAt: new Date(),
          },
        });
        await prisma.callParticipant.updateMany({
          where: { callId: call.id, status: "RINGING" },
          data: { status: "MISSED", leftAt: new Date() },
        });
        const dto = await loadCall(ended.id);
        if (dto) notifyParticipants(dto, "call.ended", undefined, { end_reason: "timeout" });
      })();
    }, RING_TTL_MS);

    const result = await tokenFor(userId, full, me?.displayName);
    return reply.code(201).send(result);
  });

  app.get("/api/calls/:id", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const { id } = req.params as { id: string };
    const call = await loadCall(id);
    if (!call) return reply.code(404).send({ error: "not_found" });
    if (!call.participants.some((p) => p.userId === userId)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    return toCallDto(call);
  });

  app.post("/api/calls/:id/:action", { preHandler: requireUser }, async (req, reply) => {
    if (!livekitConfigured()) {
      return reply.code(503).send({ error: "livekit_not_configured" });
    }
    const userId = (req as typeof req & { userId: string }).userId;
    const { id, action } = req.params as { id: string; action: string };
    const act = action.trim().toLowerCase();
    if (!["answer", "reject", "end", "leave"].includes(act)) {
      return reply.code(400).send({ error: "invalid_action" });
    }

    const call = await loadCall(id);
    if (!call) return reply.code(404).send({ error: "not_found" });
    const mine = call.participants.find((p) => p.userId === userId);
    if (!mine) return reply.code(403).send({ error: "forbidden" });

    if (act === "answer") {
      if (call.status !== "RINGING") {
        return reply.code(409).send({ error: "not_ringing" });
      }
      if (call.expiresAt && call.expiresAt.getTime() < Date.now()) {
        await prisma.call.update({
          where: { id },
          data: { status: "MISSED", endReason: "timeout", endedAt: new Date() },
        });
        return reply.code(410).send({ error: "expired" });
      }
      await prisma.call.update({
        where: { id },
        data: { status: "ACTIVE", answeredAt: new Date() },
      });
      await prisma.callParticipant.update({
        where: { callId_userId: { callId: id, userId } },
        data: { status: "JOINED", joinedAt: new Date() },
      });
      const updated = await loadCall(id);
      if (!updated) return reply.code(500).send({ error: "update_failed" });
      notifyParticipants(updated, "call.answered", userId);
      const me = await prisma.user.findUnique({ where: { id: userId } });
      return tokenFor(userId, updated, me?.displayName);
    }

    if (act === "reject") {
      if (call.status !== "RINGING") {
        return reply.code(409).send({ error: "not_ringing" });
      }
      await prisma.callParticipant.update({
        where: { callId_userId: { callId: id, userId } },
        data: { status: "REJECTED", leftAt: new Date() },
      });
      const stillRinging = await prisma.callParticipant.count({
        where: { callId: id, status: "RINGING", userId: { not: call.initiatorId } },
      });
      if (stillRinging === 0) {
        await prisma.call.update({
          where: { id },
          data: { status: "REJECTED", endReason: "rejected", endedAt: new Date() },
        });
      }
      const updated = await loadCall(id);
      if (!updated) return reply.code(500).send({ error: "update_failed" });
      realtimeHub.toUser(call.initiatorId, {
        type: "call.rejected",
        data: toCallDto(updated),
      });
      if (updated.status === "REJECTED") {
        notifyParticipants(updated, "call.ended", undefined, { end_reason: "rejected" });
      }
      return { call: toCallDto(updated), token: null, livekit_url: null, invited: false };
    }

    // end | leave
    if (["ENDED", "REJECTED", "MISSED"].includes(call.status)) {
      return { call: toCallDto(call), token: null, livekit_url: null, invited: false };
    }
    await prisma.callParticipant.update({
      where: { callId_userId: { callId: id, userId } },
      data: { status: "LEFT", leftAt: new Date() },
    });
    await prisma.call.update({
      where: { id },
      data: {
        status: "ENDED",
        endReason: userId === call.initiatorId ? "caller_hangup" : "callee_hangup",
        endedAt: new Date(),
      },
    });
    const updated = await loadCall(id);
    if (!updated) return reply.code(500).send({ error: "update_failed" });
    notifyParticipants(updated, "call.ended", undefined, {
      end_reason: updated.endReason,
    });
    return { call: toCallDto(updated), token: null, livekit_url: null, invited: false };
  });
}
