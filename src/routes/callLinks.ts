import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { livekitConfigured, livekitUrl, mintLivekitToken } from "../livekit.js";
import { requireUser } from "../plugins/auth.js";
import { callBus } from "../realtime/callBus.js";

const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function shortCode(): string {
  return randomBytes(5).toString("base64url").replace(/=+$/, "").slice(0, 8);
}

function shareUrl(code: string): string {
  // Deep link host matches Android intent-filter (wa.zirvik.com).
  return `https://wa.zirvik.com/call/${code}`;
}

function toLinkDto(link: {
  code: string;
  title: string | null;
  media: "AUDIO" | "VIDEO";
  expiresAt: Date;
  createdAt: Date;
}) {
  return {
    code: link.code,
    url: shareUrl(link.code),
    title: link.title,
    media: link.media.toLowerCase(),
    audio: link.media === "AUDIO",
    expires_at: link.expiresAt.toISOString(),
    created_at: link.createdAt.toISOString(),
  };
}

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

export async function callLinkRoutes(app: FastifyInstance) {
  app.post("/api/call-links", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    if (!livekitConfigured()) {
      return reply.code(503).send({ error: "livekit_not_configured" });
    }
    const parsed = z
      .object({
        media: z.enum(["audio", "video"]).default("audio"),
        title: z.string().trim().max(80).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    let code = shortCode();
    for (let i = 0; i < 5; i++) {
      const clash = await prisma.callLink.findUnique({ where: { code } });
      if (!clash) break;
      code = shortCode();
    }

    const media = parsed.data.media === "video" ? "VIDEO" : "AUDIO";
    const link = await prisma.callLink.create({
      data: {
        code,
        media,
        title: parsed.data.title || (media === "VIDEO" ? "Video call" : "Voice call"),
        creatorId: userId,
        expiresAt: new Date(Date.now() + LINK_TTL_MS),
      },
    });
    return reply.code(201).send(toLinkDto(link));
  });

  app.post("/api/call-links/:code", { preHandler: requireUser }, async (req, reply) => {
    const userId = (req as typeof req & { userId: string }).userId;
    if (!livekitConfigured()) {
      return reply.code(503).send({ error: "livekit_not_configured" });
    }
    const { code } = req.params as { code: string };
    if (!code?.trim()) {
      return reply.code(400).send({ error: "invalid_code" });
    }

    const link = await prisma.callLink.findUnique({
      where: { code: code.trim() },
      include: {
        creator: { select: { id: true, phone: true, displayName: true, avatarUrl: true } },
      },
    });
    if (!link) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (link.expiresAt.getTime() < Date.now()) {
      return reply.code(410).send({ error: "expired" });
    }

    const me = await prisma.user.findUnique({ where: { id: userId } });
    let call = link.activeCallId ? await loadCall(link.activeCallId) : null;

    if (!call || call.status === "ENDED" || call.status === "MISSED" || call.status === "REJECTED") {
      const roomName = `link_${link.code}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const created = await prisma.call.create({
        data: {
          kind: "link",
          media: link.media,
          conversationId: null,
          initiatorId: link.creatorId,
          roomName,
          status: "ACTIVE",
          answeredAt: new Date(),
          participants: {
            create: [{ userId, status: "JOINED", joinedAt: new Date() }],
          },
        },
      });
      await prisma.callLink.update({
        where: { id: link.id },
        data: { activeCallId: created.id },
      });
      call = await loadCall(created.id);
      callBus.changed();
    } else {
      const already = call.participants.some((p) => p.userId === userId);
      if (!already) {
        if (call.participants.length >= 16) {
          return reply.code(403).send({ error: "room_full" });
        }
        await prisma.callParticipant.create({
          data: { callId: call.id, userId, status: "JOINED", joinedAt: new Date() },
        });
        call = await loadCall(call.id);
        callBus.changed();
      }
    }

    if (!call) {
      return reply.code(500).send({ error: "join_failed" });
    }

    const token = await mintLivekitToken({
      roomName: call.roomName,
      identity: userId,
      name: me?.displayName ?? undefined,
    });

    const host = link.creator;
    return {
      code: link.code,
      title: link.title,
      media: link.media.toLowerCase(),
      audio: link.media === "AUDIO",
      room_name: call.roomName,
      token,
      livekit_url: livekitUrl(),
      host: {
        id: host.id,
        phone: host.phone,
        display_name: host.displayName,
        avatar_url: host.avatarUrl,
      },
      call: {
        id: call.id,
        kind: call.kind,
        media: call.media.toLowerCase(),
        conversation_id: call.conversationId,
        initiator_id: call.initiatorId,
        room_name: call.roomName,
        status: call.status.toLowerCase(),
        end_reason: call.endReason,
        drop_in: true,
        started_at: call.startedAt.toISOString(),
        answered_at: call.answeredAt?.toISOString() ?? null,
        ended_at: call.endedAt?.toISOString() ?? null,
        duration_seconds: 0,
        expires_at: call.expiresAt?.toISOString() ?? null,
        group_title: link.title,
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
          ringing: false,
          silenced: false,
          user: {
            id: p.user.id,
            phone: p.user.phone,
            display_name: p.user.displayName,
            avatar_url: p.user.avatarUrl,
          },
        })),
      },
    };
  });

  app.get("/api/call-links/:code", { preHandler: requireUser }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const link = await prisma.callLink.findUnique({ where: { code: code?.trim() ?? "" } });
    if (!link) return reply.code(404).send({ error: "not_found" });
    if (link.expiresAt.getTime() < Date.now()) return reply.code(410).send({ error: "expired" });
    return toLinkDto(link);
  });
}
