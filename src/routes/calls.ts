import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { livekitConfigured, livekitUrl, mintLivekitToken } from "../livekit.js";
import { messageInclude, toMessageDto } from "../messages.js";
import { requireUser } from "../plugins/auth.js";
import { notifyIncomingCall } from "../push/fcm.js";
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
      call.conversation?.type === "GROUP"
        ? call.conversation.title ?? "Group"
        : call.kind === "group"
          ? "Group call"
          : null,
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

/** Bolta/WhatsApp-style centered call notice in the chat timeline. */
function callNoticeText(call: NonNullable<CallRow>): string {
  const video = call.media === "VIDEO";
  const kind = video ? "Video call" : "Voice call";
  const reason = call.endReason ?? "";
  const dur = durationSeconds(call);

  if (call.answeredAt) {
    const m = Math.floor(dur / 60);
    const s = dur % 60;
    return `${kind} · ${m}:${s.toString().padStart(2, "0")}`;
  }
  if (reason === "rejected" || call.status === "REJECTED") {
    return `${kind} declined`;
  }
  if (reason === "cancelled") {
    return `${kind} cancelled`;
  }
  if (reason === "busy") {
    return `${kind} · busy`;
  }
  // timeout / missed / unanswered hangup
  return video ? "Missed video call" : "Missed voice call";
}

async function postCallSystemMessage(call: NonNullable<CallRow>) {
  const conversationId = call.conversationId;
  if (!conversationId) return;
  try {
    const notice = await prisma.message.create({
      data: {
        conversationId,
        senderId: call.initiatorId,
        type: "TEXT",
        text: callNoticeText(call),
        clientId: `call-notice-${call.id}`,
        payload: {
          system: true,
          kind: "call",
          call_id: call.id,
          media: call.media.toLowerCase(),
          end_reason: call.endReason,
          status: call.status.toLowerCase(),
          duration_seconds: durationSeconds(call),
        },
        status: "SENT",
      },
      include: messageInclude,
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    const dto = toMessageDto(notice);
    realtimeHub.toRoom(conversationId, { type: "message", data: dto });
    const peers = await prisma.conversationMember.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    for (const peer of peers) {
      if (!realtimeHub.isInRoom(peer.userId, conversationId)) {
        realtimeHub.toUser(peer.userId, { type: "message", data: dto });
      }
    }
  } catch {
    // Unique clientId on retry — ignore.
  }
}

/** Shared LiveKit ring path used by POST /api/calls and scheduled-call start. */
export async function createAndRingCall(opts: {
  userId: string;
  conversationId: string | null;
  calleeIds: string[];
  media: "audio" | "video";
}): Promise<
  | { ok: true; result: Awaited<ReturnType<typeof tokenFor>> }
  | { ok: false; code: number; error: string }
> {
  if (!livekitConfigured()) {
    return { ok: false, code: 503, error: "livekit_not_configured" };
  }

  const calleeIds = [...new Set(opts.calleeIds)].filter((id) => id !== opts.userId);
  if (calleeIds.length === 0) {
    return { ok: false, code: 400, error: "no_callees" };
  }
  if (calleeIds.length > 8) {
    return { ok: false, code: 400, error: "too_many_callees" };
  }

  const blocks = await prisma.block.findMany({
    where: {
      OR: [
        { blockerId: opts.userId, blockedId: { in: calleeIds } },
        { blockerId: { in: calleeIds }, blockedId: opts.userId },
      ],
    },
  });
  if (blocks.length > 0) {
    return { ok: false, code: 403, error: "blocked" };
  }

  const me = await prisma.user.findUnique({ where: { id: opts.userId } });
  const roomName = `call_${randomUUID().replace(/-/g, "")}`;
  const media = opts.media === "video" ? "VIDEO" : "AUDIO";
  const expiresAt = new Date(Date.now() + RING_TTL_MS);

  const call = await prisma.call.create({
    data: {
      kind: calleeIds.length > 1 ? "group" : "direct",
      media,
      conversationId: opts.conversationId,
      initiatorId: opts.userId,
      roomName,
      status: "RINGING",
      expiresAt,
      participants: {
        create: [
          { userId: opts.userId, status: "JOINED", joinedAt: new Date() },
          ...calleeIds.map((id) => ({ userId: id, status: "RINGING" as const })),
        ],
      },
    },
  });

  const full = await loadCall(call.id);
  if (!full) {
    return { ok: false, code: 500, error: "create_failed" };
  }

  for (const calleeId of calleeIds) {
    realtimeHub.toUser(calleeId, {
      type: "call.incoming",
      data: toCallDto(full),
    });
  }
  void notifyIncomingCall({
    calleeIds,
    callId: full.id,
    media: full.media.toLowerCase(),
    callerName: full.initiator.displayName || full.initiator.phone || "Aivora",
    conversationId: full.conversationId,
  }).catch(() => undefined);

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
      if (dto) {
        notifyParticipants(dto, "call.ended", undefined, { end_reason: "timeout" });
        await postCallSystemMessage(dto);
      }
    })();
  }, RING_TTL_MS);

  const result = await tokenFor(opts.userId, full, me?.displayName);
  return { ok: true, result };
}

export async function callRoutes(app: FastifyInstance) {
  app.post("/api/calls", { preHandler: requireUser }, async (req, reply) => {
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
    } else {
      return reply.code(400).send({ error: "conversation_or_users_required" });
    }

    const started = await createAndRingCall({
      userId,
      conversationId,
      calleeIds,
      media: parsed.data.media,
    });
    if (!started.ok) {
      return reply.code(started.code).send({ error: started.error });
    }
    return reply.code(201).send(started.result);
  });

  app.get("/api/calls/history", { preHandler: requireUser }, async (req) => {
    const userId = (req as typeof req & { userId: string }).userId;
    const q = req.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));

    const rows = await prisma.call.findMany({
      where: { participants: { some: { userId } } },
      orderBy: { startedAt: "desc" },
      take: limit,
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

    return {
      items: rows.map((call) => {
        const dto = toCallDto(call);
        const peer = call.participants.find((p) => p.userId !== userId)?.user;
        const peerName =
          call.conversation?.type === "GROUP"
            ? call.conversation.title || "Group"
            : peer?.displayName || peer?.phone || dto.caller?.name || "Unknown";
        const outgoing = call.initiatorId === userId;
        const missed =
          !outgoing &&
          (call.status === "MISSED" ||
            call.status === "REJECTED" ||
            call.participants.some(
              (p) => p.userId === userId && (p.status === "MISSED" || p.status === "REJECTED"),
            ));
        const direction = outgoing ? "outgoing" : missed ? "missed" : "incoming";
        return {
          ...dto,
          peer_name: peerName,
          peer_user_id: peer?.id ?? null,
          peer_avatar_url: peer?.avatarUrl ?? null,
          direction,
          missed,
          video: call.media === "VIDEO",
        };
      }),
    };
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
      // 1:1 decline always ends the call for everyone.
      await prisma.callParticipant.update({
        where: { callId_userId: { callId: id, userId } },
        data: { status: "REJECTED", leftAt: new Date() },
      });
      await prisma.callParticipant.updateMany({
        where: { callId: id, status: "RINGING" },
        data: { status: "MISSED", leftAt: new Date() },
      });
      await prisma.call.update({
        where: { id },
        data: { status: "REJECTED", endReason: "rejected", endedAt: new Date() },
      });
      const updated = await loadCall(id);
      if (!updated) return reply.code(500).send({ error: "update_failed" });
      // Tear down every participant UI (caller ringing + any other devices).
      notifyParticipants(updated, "call.rejected", undefined, { end_reason: "rejected" });
      notifyParticipants(updated, "call.ended", undefined, { end_reason: "rejected" });
      await postCallSystemMessage(updated);
      return { call: toCallDto(updated), token: null, livekit_url: null, invited: false };
    }

    // end | leave (hang up / cancel while ringing)
    if (["ENDED", "REJECTED", "MISSED"].includes(call.status)) {
      return { call: toCallDto(call), token: null, livekit_url: null, invited: false };
    }
    const wasRinging = call.status === "RINGING";
    const endReason = wasRinging
      ? userId === call.initiatorId
        ? "cancelled"
        : "callee_hangup"
      : userId === call.initiatorId
        ? "caller_hangup"
        : "callee_hangup";
    await prisma.callParticipant.update({
      where: { callId_userId: { callId: id, userId } },
      data: { status: "LEFT", leftAt: new Date() },
    });
    if (wasRinging) {
      await prisma.callParticipant.updateMany({
        where: { callId: id, status: "RINGING" },
        data: { status: "MISSED", leftAt: new Date() },
      });
    }
    await prisma.call.update({
      where: { id },
      data: {
        status: wasRinging ? "MISSED" : "ENDED",
        endReason,
        endedAt: new Date(),
      },
    });
    const updated = await loadCall(id);
    if (!updated) return reply.code(500).send({ error: "update_failed" });
    notifyParticipants(updated, "call.ended", undefined, {
      end_reason: endReason,
    });
    await postCallSystemMessage(updated);
    return { call: toCallDto(updated), token: null, livekit_url: null, invited: false };
  });
}

/** Admin moderation: tear down a ringing/active call for every participant. */
export async function forceEndCallByAdmin(callId: string): Promise<
  | { ok: true; call: ReturnType<typeof toCallDto> }
  | { ok: false; code: number; error: string }
> {
  const call = await loadCall(callId);
  if (!call) return { ok: false, code: 404, error: "not_found" };
  if (["ENDED", "REJECTED", "MISSED"].includes(call.status)) {
    return { ok: true, call: toCallDto(call) };
  }
  const wasRinging = call.status === "RINGING";
  await prisma.callParticipant.updateMany({
    where: { callId, status: { in: ["RINGING", "JOINED"] } },
    data: { status: "LEFT", leftAt: new Date() },
  });
  await prisma.call.update({
    where: { id: callId },
    data: {
      status: wasRinging ? "MISSED" : "ENDED",
      endReason: "admin_force_end",
      endedAt: new Date(),
    },
  });
  const updated = await loadCall(callId);
  if (!updated) return { ok: false, code: 500, error: "update_failed" };
  notifyParticipants(updated, "call.ended", undefined, {
    end_reason: "admin_force_end",
  });
  await postCallSystemMessage(updated);
  return { ok: true, call: toCallDto(updated) };
}
