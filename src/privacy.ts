import { prisma } from "./db.js";

export type PrivacyLevel = "everyone" | "contacts" | "nobody" | "same_as_last_seen";

/** Whether viewer may see target's last-seen / online. Reciprocal: if target hides from viewer, viewer also hidden. */
export async function canSeePresence(
  viewerId: string,
  targetId: string,
  kind: "last_seen" | "online",
): Promise<boolean> {
  if (viewerId === targetId) return true;
  const [viewer, target] = await Promise.all([
    prisma.user.findUnique({
      where: { id: viewerId },
      select: { lastSeenPrivacy: true, onlinePrivacy: true },
    }),
    prisma.user.findUnique({
      where: { id: targetId },
      select: { lastSeenPrivacy: true, onlinePrivacy: true, lastSeenAt: true },
    }),
  ]);
  if (!viewer || !target) return false;

  const targetSetting =
    kind === "last_seen"
      ? target.lastSeenPrivacy
      : target.onlinePrivacy === "same_as_last_seen"
        ? target.lastSeenPrivacy
        : target.onlinePrivacy;

  const viewerSetting =
    kind === "last_seen"
      ? viewer.lastSeenPrivacy
      : viewer.onlinePrivacy === "same_as_last_seen"
        ? viewer.lastSeenPrivacy
        : viewer.onlinePrivacy;

  if (targetSetting === "nobody" || viewerSetting === "nobody") return false;
  if (targetSetting === "everyone" && viewerSetting === "everyone") return true;

  // "contacts" = share only if they have a DIRECT conversation (mutual chat).
  if (targetSetting === "contacts" || viewerSetting === "contacts") {
    const key = [viewerId, targetId].sort().join(":");
    const direct = await prisma.conversation.findUnique({ where: { directKey: key } });
    return Boolean(direct);
  }
  return true;
}

export async function touchLastSeen(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { lastSeenAt: new Date() },
  });
}
