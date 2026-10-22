import type { User } from "@prisma/client";

export function toUserDto(user: User) {
  return {
    id: user.id,
    phone: user.phone,
    phone_display: user.phone,
    display_name: user.displayName,
    about: user.about,
    avatar_url: user.avatarUrl,
    avatar_thumb: user.avatarUrl,
    created_at: user.createdAt.toISOString(),
  };
}
