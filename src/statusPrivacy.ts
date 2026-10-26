import { prisma } from "./db.js";
import { isBlockedEitherWay } from "./blocks.js";

export type StatusAudience = "everyone" | "contacts" | "contacts_except" | "only_share";

export function asIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Peer user ids that share a DIRECT conversation with userId. */
export async function directContactIds(userId: string): Promise<string[]> {
  const memberships = await prisma.conversationMember.findMany({
    where: {
      userId,
      conversation: { type: "DIRECT" },
    },
    select: {
      conversation: {
        select: {
          members: { select: { userId: true } },
        },
      },
    },
  });
  const peers = new Set<string>();
  for (const m of memberships) {
    for (const peer of m.conversation.members) {
      if (peer.userId !== userId) peers.add(peer.userId);
    }
  }
  return [...peers];
}

/**
 * Whether viewer may see author's status given audience snapshot on the status
 * (or author's default privacy when evaluating eligible recipients at create).
 */
export async function canViewerSeeStatus(opts: {
  authorId: string;
  viewerId: string;
  audience: string;
  audienceIds: unknown;
}): Promise<boolean> {
  const { authorId, viewerId, audience } = opts;
  if (authorId === viewerId) return true;
  if (await isBlockedEitherWay(authorId, viewerId)) return false;

  const ids = new Set(asIdList(opts.audienceIds));
  const mode = (audience || "contacts") as StatusAudience;

  if (mode === "everyone") return true;
  if (mode === "only_share") return ids.has(viewerId);
  if (mode === "contacts_except") {
    if (ids.has(viewerId)) return false;
    const contacts = await directContactIds(authorId);
    return contacts.includes(viewerId);
  }
  // contacts (default)
  const contacts = await directContactIds(authorId);
  return contacts.includes(viewerId);
}

/** Eligible peer ids for a new status (excluding author). */
export async function eligibleStatusRecipients(opts: {
  authorId: string;
  audience: string;
  audienceIds: unknown;
}): Promise<string[]> {
  const { authorId } = opts;
  const mode = (opts.audience || "contacts") as StatusAudience;
  const ids = asIdList(opts.audienceIds);

  let candidates: string[] = [];
  if (mode === "everyone") {
    const users = await prisma.user.findMany({
      where: { id: { not: authorId }, bannedAt: null },
      select: { id: true },
      take: 5_000,
    });
    candidates = users.map((u) => u.id);
  } else if (mode === "only_share") {
    candidates = ids.filter((id) => id !== authorId);
  } else if (mode === "contacts_except") {
    const except = new Set(ids);
    candidates = (await directContactIds(authorId)).filter((id) => !except.has(id));
  } else {
    candidates = await directContactIds(authorId);
  }

  const out: string[] = [];
  for (const peerId of candidates) {
    if (await isBlockedEitherWay(authorId, peerId)) continue;
    out.push(peerId);
  }
  return out;
}
