import { prisma } from "./db.js";
import { realtimeHub } from "./realtime/hub.js";

/** Tell every peer in shared chats that this user went online/offline (app-level). */
export async function broadcastUserPresence(userId: string, online: boolean) {
  const seenAt = online ? null : new Date().toISOString();
  if (!online) {
    void import("./privacy.js").then(({ touchLastSeen }) => touchLastSeen(userId));
  }

  const memberships = await prisma.conversationMember.findMany({
    where: { userId },
    select: { conversationId: true },
  });
  if (memberships.length === 0) return;

  const conversationIds = memberships.map((m) => m.conversationId);
  const peers = await prisma.conversationMember.findMany({
    where: {
      conversationId: { in: conversationIds },
      userId: { not: userId },
    },
    select: { userId: true, conversationId: true },
  });

  const byPeer = new Map<string, string[]>();
  for (const p of peers) {
    const list = byPeer.get(p.userId) ?? [];
    list.push(p.conversationId);
    byPeer.set(p.userId, list);
  }

  for (const [peerId, rooms] of byPeer) {
    for (const conversationId of rooms) {
      realtimeHub.toUser(peerId, {
        type: "presence",
        data: {
          user_id: userId,
          conversation_id: conversationId,
          online,
          last_seen_at: seenAt,
        },
      });
    }
  }
}

/** Members of a conversation who currently have the app open (WS attached). */
export async function onlineMemberIds(conversationId: string): Promise<string[]> {
  const members = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  return members.map((m) => m.userId).filter((id) => realtimeHub.isOnline(id));
}
