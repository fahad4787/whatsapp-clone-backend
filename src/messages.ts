import type { Message } from "@prisma/client";

export function toMessageDto(msg: Message) {
  return {
    id: msg.id,
    conversation_id: msg.conversationId,
    sender_id: msg.senderId,
    type: msg.type.toLowerCase(),
    text: msg.text,
    attachment: msg.attachment ?? null,
    client_id: msg.clientId,
    status: msg.status.toLowerCase(),
    created_at: msg.createdAt.toISOString(),
    updated_at: msg.updatedAt.toISOString(),
  };
}
