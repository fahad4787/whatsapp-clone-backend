import type { Message, MessageReaction } from "@prisma/client";

type MessageWithExtras = Message & {
  replyTo?: Message | null;
  reactions?: MessageReaction[];
  stars?: { userId: string }[];
};

function replyPreview(msg: Message | null | undefined) {
  if (!msg) return null;
  const deleted = Boolean(msg.deletedForEveryoneAt);
  return {
    id: msg.id,
    sender_id: msg.senderId,
    type: msg.type.toLowerCase(),
    text: deleted ? null : msg.text,
    deleted,
  };
}

function reactionSummaries(reactions: MessageReaction[] | undefined) {
  if (!reactions?.length) return [];
  const map = new Map<string, { emoji: string; count: number; user_ids: string[] }>();
  for (const r of reactions) {
    const cur = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, user_ids: [] as string[] };
    cur.count += 1;
    cur.user_ids.push(r.userId);
    map.set(r.emoji, cur);
  }
  return [...map.values()];
}

export function toMessageDto(msg: MessageWithExtras, viewerId?: string) {
  const deleted = Boolean(msg.deletedForEveryoneAt);
  return {
    id: msg.id,
    conversation_id: msg.conversationId,
    sender_id: msg.senderId,
    type: msg.type.toLowerCase(),
    text: deleted ? null : msg.text,
    attachment: deleted ? null : (msg.attachment ?? null),
    client_id: msg.clientId,
    status: msg.status.toLowerCase(),
    deleted_for_everyone_at: msg.deletedForEveryoneAt?.toISOString() ?? null,
    reply_to: replyPreview(msg.replyTo),
    forwarded: msg.forwarded,
    reactions: reactionSummaries(msg.reactions),
    starred: viewerId ? Boolean(msg.stars?.some((s) => s.userId === viewerId)) : false,
    created_at: msg.createdAt.toISOString(),
    updated_at: msg.updatedAt.toISOString(),
  };
}

export const messageInclude = {
  replyTo: true,
  reactions: true,
  stars: true,
} as const;
