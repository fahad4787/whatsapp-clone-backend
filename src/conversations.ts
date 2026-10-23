import type { Conversation, ConversationMember, Message, User } from "@prisma/client";
import { prisma } from "./db.js";
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

export async function blockFlagsForDirect(
  viewerId: string,
  peerId: string | undefined,
): Promise<{ blocked_by_me: boolean; blocked_me: boolean }> {
  if (!peerId) return { blocked_by_me: false, blocked_me: false };
  const rows = await prisma.block.findMany({
    where: {
      OR: [
        { blockerId: viewerId, blockedId: peerId },
        { blockerId: peerId, blockedId: viewerId },
      ],
    },
    select: { blockerId: true },
  });
  return {
    blocked_by_me: rows.some((r) => r.blockerId === viewerId),
    blocked_me: rows.some((r) => r.blockerId === peerId),
  };
}

export function toConversationDto(
  conv: ConversationWithMembers,
  viewerId: string,
  unreadCount = 0,
  blockFlags: { blocked_by_me: boolean; blocked_me: boolean } = {
    blocked_by_me: false,
    blocked_me: false,
  },
) {
  const me = conv.members.find((m) => m.userId === viewerId);
  const peers = conv.members.filter((m) => m.userId !== viewerId);
  const peer = conv.type === "DIRECT" ? peers[0]?.user : undefined;
  const blocked = blockFlags.blocked_by_me || blockFlags.blocked_me;

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
    unread_count: unreadCount,
    archived: me?.archived ?? false,
    pinned: Boolean(me?.pinnedAt),
    muted_until: me?.mutedUntil?.toISOString() ?? null,
    blocked_by_me: blockFlags.blocked_by_me,
    blocked_me: blockFlags.blocked_me,
    my_role: me?.role === "ADMIN" ? "admin" : "member",
    only_admins_can_send: conv.onlyAdminsCanSend ?? false,
    only_admins_can_edit_info: conv.onlyAdminsCanEditInfo ?? false,
    disappearing_seconds: conv.disappearingSeconds ?? 0,
    disappearing_set_by: conv.disappearingSetBy ?? null,
    disappearing_set_at: conv.disappearingSetAt?.toISOString() ?? null,
    peer: peer
      ? {
          id: peer.id,
          phone: peer.phone,
          phone_display: peer.phone,
          display_name: peer.displayName,
          about: peer.about,
          avatar_url: peer.avatarUrl,
          avatar_thumb: peer.avatarUrl,
          last_seen_at: null as string | null,
          presence_visible: true,
        }
      : null,
    members: conv.members.map((m) => ({
      role: m.role === "ADMIN" ? "admin" : "member",
      joined_at: m.joinedAt.toISOString(),
      user: toUserDto(m.user),
    })),
  };
}

export async function toConversationDtoAsync(
  conv: ConversationWithMembers,
  viewerId: string,
  unreadCount = 0,
) {
  const peerId =
    conv.type === "DIRECT"
      ? conv.members.find((m) => m.userId !== viewerId)?.userId
      : undefined;
  const flags = await blockFlagsForDirect(viewerId, peerId);
  const dto = toConversationDto(conv, viewerId, unreadCount, flags);
  if (dto.peer && peerId && !flags.blocked_by_me && !flags.blocked_me) {
    const { canSeePresence } = await import("./privacy.js");
    const [allowLastSeen, allowOnline] = await Promise.all([
      canSeePresence(viewerId, peerId, "last_seen"),
      canSeePresence(viewerId, peerId, "online"),
    ]);
    dto.peer.presence_visible = allowOnline;
    if (allowLastSeen) {
      const peerUser = conv.members.find((m) => m.userId === peerId)?.user;
      dto.peer.last_seen_at = peerUser?.lastSeenAt?.toISOString() ?? null;
    } else {
      dto.peer.last_seen_at = null;
    }
  } else if (dto.peer && (flags.blocked_by_me || flags.blocked_me)) {
    dto.peer.presence_visible = false;
    dto.peer.last_seen_at = null;
  }
  return dto;
}
