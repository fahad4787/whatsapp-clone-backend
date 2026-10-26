import type { Status, StatusView, User } from "@prisma/client";
import { toUserDto } from "./profile.js";

type StatusWithViews = Status & {
  views: StatusView[];
  user?: User;
};

export function toStatusItemDto(status: StatusWithViews, viewerId: string) {
  const myView = status.views.find((v) => v.userId === viewerId);
  const isOwner = status.userId === viewerId;
  return {
    id: status.id,
    kind: status.kind,
    text: status.text,
    background: status.background,
    attachment: status.attachment ?? null,
    created_at: status.createdAt.toISOString(),
    expires_at: status.expiresAt.toISOString(),
    seen: Boolean(myView) || isOwner,
    view_count: isOwner ? status.views.length : 0,
    my_reaction: myView?.reaction ?? null,
  };
}

export function toStatusRowDto(
  author: User,
  statuses: StatusWithViews[],
  viewerId: string,
) {
  const items = statuses.map((s) => toStatusItemDto(s, viewerId));
  const unseen = items.filter((i) => !i.seen).length;
  const latest = statuses[0]?.createdAt ?? null;
  return {
    user: toUserDto(author),
    statuses: items,
    unseen: String(unseen),
    latest_at: latest?.toISOString() ?? null,
  };
}
