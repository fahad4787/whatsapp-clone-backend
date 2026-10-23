import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { verifyAccessToken } from "../auth/jwt.js";
import { prisma } from "../db.js";
import { broadcastUserPresence, onlineMemberIds } from "../presenceBroadcast.js";
import { realtimeHub, type RealtimeFrame } from "../realtime/hub.js";

async function assertMember(conversationId: string, userId: string) {
  return prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: { conversationId, userId },
    },
  });
}

function tokenFromRequest(req: { headers: { authorization?: string }; query: unknown }): string | null {
  const q = req.query as { token?: string };
  if (q.token?.trim()) return q.token.trim();
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
}

export async function wsRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
    const token = tokenFromRequest(req);
    if (!token) {
      socket.close(4401, "unauthorized");
      return;
    }

    let userId: string;
    try {
      userId = verifyAccessToken(token).sub;
    } catch {
      socket.close(4401, "unauthorized");
      return;
    }

    const wasOffline = !realtimeHub.isOnline(userId);
    realtimeHub.attach(socket, userId);
    realtimeHub.send(socket, { type: "auth.ok", data: { user_id: userId } });
    // First socket for this user → app is in foreground / online.
    if (wasOffline) {
      void broadcastUserPresence(userId, true);
    }

    socket.on("message", (raw: WebSocket.RawData) => {
      void (async () => {
        let frame: RealtimeFrame;
        try {
          frame = JSON.parse(String(raw)) as RealtimeFrame;
        } catch {
          realtimeHub.send(socket, { type: "error", data: { error: "invalid_json" } });
          return;
        }

        const type = String(frame.type ?? "");
        if (type === "ping") {
          realtimeHub.send(socket, { type: "pong" });
          return;
        }

        if (type === "join") {
          const parsed = z
            .object({ conversation_id: z.string().min(1) })
            .safeParse(frame.data);
          if (!parsed.success) {
            realtimeHub.send(socket, { type: "error", data: { error: "invalid_join" } });
            return;
          }
          const member = await assertMember(parsed.data.conversation_id, userId);
          if (!member) {
            realtimeHub.send(socket, { type: "error", data: { error: "not_member" } });
            return;
          }
          realtimeHub.joinRoom(socket, parsed.data.conversation_id);
          // Snapshot of who has the app open (not merely who has this chat open).
          const onlineIds = await onlineMemberIds(parsed.data.conversation_id);
          realtimeHub.send(socket, {
            type: "presence_snapshot",
            data: {
              conversation_id: parsed.data.conversation_id,
              online_user_ids: onlineIds,
            },
          });
          realtimeHub.send(socket, {
            type: "joined",
            data: { conversation_id: parsed.data.conversation_id },
          });
          return;
        }

        if (type === "leave") {
          const parsed = z
            .object({ conversation_id: z.string().min(1) })
            .safeParse(frame.data);
          if (!parsed.success) return;
          realtimeHub.leaveRoom(socket, parsed.data.conversation_id);
          // Leaving a chat does NOT mean offline — only WS disconnect does.
          return;
        }

        if (type === "typing") {
          const parsed = z
            .object({
              conversation_id: z.string().min(1),
              typing: z.boolean(),
            })
            .safeParse(frame.data);
          if (!parsed.success) return;
          const member = await assertMember(parsed.data.conversation_id, userId);
          if (!member) return;
          realtimeHub.toRoom(
            parsed.data.conversation_id,
            {
              type: "typing",
              data: {
                conversation_id: parsed.data.conversation_id,
                user_id: userId,
                typing: parsed.data.typing,
              },
            },
            userId,
          );
        }
      })();
    });

    socket.on("close", () => {
      realtimeHub.detach(socket);
      // Last socket gone → app backgrounded / killed → offline.
      if (!realtimeHub.isOnline(userId)) {
        void broadcastUserPresence(userId, false);
      }
    });
  });
}
