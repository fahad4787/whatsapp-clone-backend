import type { Message } from "@prisma/client";

export function toMessageDto(msg: Message) {
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
    created_at: msg.createdAt.toISOString(),
    updated_at: msg.updatedAt.toISOString(),
  };
}
