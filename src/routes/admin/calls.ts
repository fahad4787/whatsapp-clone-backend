import type { FastifyInstance } from "fastify";
import { prisma } from "../../db.js";
import { requireAdmin } from "../../plugins/auth.js";
import { callBus } from "../../realtime/callBus.js";
import { forceEndCallByAdmin } from "../calls.js";

const callInclude = {
  initiator: { select: { id: true, phone: true, displayName: true, avatarUrl: true } },
  participants: {
    include: {
      user: { select: { id: true, phone: true, displayName: true, avatarUrl: true } },
    },
  },
  conversation: { select: { id: true, type: true, title: true } },
} as const;

function labelUser(u: { displayName: string | null; phone: string }) {
  return u.displayName?.trim() || u.phone;
}

function durationSeconds(call: { answeredAt: Date | null; endedAt: Date | null }) {
  if (!call.answeredAt || !call.endedAt) return 0;
  return Math.max(0, Math.round((call.endedAt.getTime() - call.answeredAt.getTime()) / 1000));
}

type CallWithParts = Awaited<
  ReturnType<
    typeof prisma.call.findMany<{ include: typeof callInclude }>
  >
>[number];

function toAdminCallDto(call: CallWithParts) {
  const names = call.participants.map((p) => labelUser(p.user));
  return {
    id: call.id,
    kind: call.kind,
    media: call.media.toLowerCase(),
    status: call.status.toLowerCase(),
    end_reason: call.endReason,
    room_name: call.roomName,
    conversation_id: call.conversationId,
    conversation_title:
      call.conversation?.type === "GROUP"
        ? call.conversation.title ?? "Group"
        : null,
    initiator: {
      id: call.initiator.id,
      phone: call.initiator.phone,
      display_name: call.initiator.displayName,
    },
    participants: call.participants.map((p) => ({
      user_id: p.userId,
      status: p.status.toLowerCase(),
      phone: p.user.phone,
      display_name: p.user.displayName,
    })),
    participants_label: names.join(", "),
    started_at: call.startedAt.toISOString(),
    answered_at: call.answeredAt?.toISOString() ?? null,
    ended_at: call.endedAt?.toISOString() ?? null,
    duration_seconds: durationSeconds(call),
    expires_at: call.expiresAt?.toISOString() ?? null,
  };
}

async function loadLiveSnapshot() {
  const [rows, active, today] = await Promise.all([
    prisma.call.findMany({
      where: { status: { in: ["RINGING", "ACTIVE"] } },
      orderBy: { startedAt: "desc" },
      take: 100,
      include: callInclude,
    }),
    prisma.call.count({ where: { status: { in: ["RINGING", "ACTIVE"] } } }),
    prisma.call.count({
      where: {
        startedAt: {
          gte: (() => {
            const d = new Date();
            d.setUTCHours(0, 0, 0, 0);
            return d;
          })(),
        },
      },
    }),
  ]);
  const items = rows.map((r) => toAdminCallDto(r));
  return {
    type: "calls" as const,
    items,
    count: items.length,
    calls_active: active,
    calls_today: today,
  };
}

export async function adminCallRoutes(app: FastifyInstance) {
  app.get("/api/admin/calls/live", { preHandler: requireAdmin }, async () => {
    const snap = await loadLiveSnapshot();
    return { items: snap.items, count: snap.count };
  });

  /** Live SSE for admin UI — EventSource uses ?token= (no Authorization header). */
  app.get("/api/admin/calls/stream", { preHandler: requireAdmin }, async (req, reply) => {
    reply.hijack();
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Vary"] = "Origin";
    }
    reply.raw.writeHead(200, headers);
    reply.raw.write("\n");

    let closed = false;
    const push = async () => {
      if (closed) return;
      try {
        const payload = JSON.stringify(await loadLiveSnapshot());
        reply.raw.write(`data: ${payload}\n\n`);
      } catch (err) {
        req.log.warn({ err }, "admin.calls.stream_push_failed");
      }
    };

    await push();
    const onChanged = () => {
      void push();
    };
    callBus.on("changed", onChanged);
    const keepalive = setInterval(() => {
      if (!closed) reply.raw.write(": keepalive\n\n");
    }, 20_000);
    // Safety net if a code path forgets callBus.changed().
    const poll = setInterval(() => {
      void push();
    }, 12_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      callBus.off("changed", onChanged);
      clearInterval(keepalive);
      clearInterval(poll);
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });

  app.get("/api/admin/calls", { preHandler: requireAdmin }, async (req) => {
    const q = req.query as {
      q?: string;
      status?: string;
      media?: string;
      limit?: string;
    };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    const search = q.q?.trim();
    const statusRaw = q.status?.trim().toUpperCase();
    const mediaRaw = q.media?.trim().toUpperCase();
    const status =
      statusRaw && ["RINGING", "ACTIVE", "ENDED", "REJECTED", "MISSED"].includes(statusRaw)
        ? statusRaw
        : undefined;
    const media =
      mediaRaw === "AUDIO" || mediaRaw === "VIDEO" ? mediaRaw : undefined;

    const rows = await prisma.call.findMany({
      where: {
        ...(status ? { status: status as "RINGING" | "ACTIVE" | "ENDED" | "REJECTED" | "MISSED" } : {}),
        ...(media ? { media: media as "AUDIO" | "VIDEO" } : {}),
        ...(search
          ? {
              OR: [
                { id: { equals: search } },
                { roomName: { contains: search, mode: "insensitive" } },
                {
                  initiator: {
                    OR: [
                      { phone: { contains: search } },
                      { displayName: { contains: search, mode: "insensitive" } },
                    ],
                  },
                },
                {
                  participants: {
                    some: {
                      user: {
                        OR: [
                          { phone: { contains: search } },
                          { displayName: { contains: search, mode: "insensitive" } },
                        ],
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: { startedAt: "desc" },
      take: limit,
      include: callInclude,
    });

    return { items: rows.map((r) => toAdminCallDto(r)) };
  });

  app.post("/api/admin/calls/:id/end", { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const result = await forceEndCallByAdmin(id);
    if (!result.ok) {
      return reply.code(result.code).send({ error: result.error });
    }
    req.log.info({ callId: id }, "admin.force_end_call");
    return { call: result.call };
  });
}
