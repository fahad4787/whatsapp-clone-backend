import type { Conversation, ConversationMember, Message, User } from "@prisma/client";
import { toMessageDto } from "./messages.js";
import { toUserDto } from "./profile.js";

type MemberWithUser = ConversationMember & { user: User };
type ConversationWithMembers = Conversation & {
  members: MemberWithUser[];
  messages?: Message[];
};

export function directKeyFor(userA: string, userB: string): string {
  return [userA, userB].sort().join(":");
}

export function toConversationDto(conv: ConversationWithMembers, viewerId: string) {
  const me = conv.members.find((m) => m.userId === viewerId);
  const peers = conv.members.filter((m) => m.userId !== viewerId);
  const peer = conv.type === "DIRECT" ? peers[0]?.user : undefined;

  const title =
    conv.type === "GROUP"
      ? conv.title
      : peer?.displayName || peer?.phone || "Chat";
  const last = conv.messages?.[0] ?? null;

  return {
    id: conv.id,
    type: conv.type === "GROUP" ? "group" : "direct",
    title,
    description: conv.description,
    avatar_url: conv.type === "GROUP" ? conv.avatarUrl : peer?.avatarUrl ?? null,
    avatar_thumb: conv.type === "GROUP" ? conv.avatarUrl : peer?.avatarUrl ?? null,
    created_at: conv.createdAt.toISOString(),
    updated_at: conv.updatedAt.toISOString(),
    last_message: last ? toMessageDto(last) : null,
    last_message_at: last?.createdAt.toISOString() ?? null,
    unread_count: 0,
    archived: me?.archived ?? false,
    pinned: false,
    my_role: me?.role === "ADMIN" ? "admin" : "member",
    peer: peer
      ? {
          id: peer.id,
          phone: peer.phone,
          phone_display: peer.phone,
          display_name: peer.displayName,
          about: peer.about,
          avatar_url: peer.avatarUrl,
          avatar_thumb: peer.avatarUrl,
        }
      : null,
    members: conv.members.map((m) => ({
      role: m.role === "ADMIN" ? "admin" : "member",
      joined_at: m.joinedAt.toISOString(),
      user: toUserDto(m.user),
    })),
  };
}
