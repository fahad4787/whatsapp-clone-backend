import type { Message, MessageReaction, MessageType } from "@prisma/client";
import { randomUUID } from "node:crypto";

type MessageWithExtras = Message & {
  replyTo?: Message | null;
  reactions?: MessageReaction[];
  stars?: { userId: string }[];
  viewOnceOpens?: { userId: string }[];
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

type PollPayload = {
  question: string;
  multiple: boolean;
  closed?: boolean;
  options: { id: string; text: string; voter_ids: string[] }[];
};

type EventPayload = {
  title: string;
  description?: string | null;
  location?: string | null;
  starts_at: string;
  ends_at?: string | null;
  timezone?: string | null;
  with_call?: boolean;
  cancelled?: boolean;
  rsvps: { user_id: string; answer: "going" | "maybe" | "not_going"; plus_one?: boolean }[];
};

type ContactPayload = {
  name: string;
  phones: string[];
  user_id?: string | null;
};

type LocationPayload = {
  lat: number;
  lng: number;
  address?: string | null;
  name?: string | null;
  /** Wave 26 — live share */
  live?: boolean;
  accuracy?: number | null;
  duration_seconds?: number | null;
  started_at?: string | null;
  expires_at?: string | null;
  ended?: boolean;
  updated_at?: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function pollToDto(payload: unknown, viewerId?: string) {
  const p = asRecord(payload);
  if (!p) return null;
  const options = Array.isArray(p.options) ? p.options : [];
  const mapped = options.map((o) => {
    const opt = asRecord(o) ?? {};
    const voterIds = Array.isArray(opt.voter_ids)
      ? opt.voter_ids.map(String)
      : [];
    return {
      id: String(opt.id ?? ""),
      text: String(opt.text ?? ""),
      votes: voterIds.length,
      voter_ids: voterIds,
      mine: viewerId ? voterIds.includes(viewerId) : false,
    };
  });
  const voters = new Set<string>();
  for (const o of mapped) o.voter_ids.forEach((id) => voters.add(id));
  return {
    question: String(p.question ?? ""),
    multiple: Boolean(p.multiple),
    closed: Boolean(p.closed),
    total_voters: voters.size,
    options: mapped,
  };
}

export function eventToDto(payload: unknown, viewerId?: string) {
  const p = asRecord(payload);
  if (!p) return null;
  const rsvps = Array.isArray(p.rsvps) ? p.rsvps : [];
  const going: unknown[] = [];
  const maybe: unknown[] = [];
  const notGoing: unknown[] = [];
  let myAnswer: string | null = null;
  let myPlusOne: boolean | null = null;
  for (const raw of rsvps) {
    const r = asRecord(raw);
    if (!r) continue;
    const entry = {
      user_id: String(r.user_id ?? ""),
      answer: String(r.answer ?? ""),
      plus_one: Boolean(r.plus_one),
    };
    if (viewerId && entry.user_id === viewerId) {
      myAnswer = entry.answer;
      myPlusOne = entry.plus_one;
    }
    if (entry.answer === "going") going.push(entry);
    else if (entry.answer === "maybe") maybe.push(entry);
    else if (entry.answer === "not_going") notGoing.push(entry);
  }
  return {
    title: String(p.title ?? ""),
    description: p.description == null ? null : String(p.description),
    location: p.location == null ? null : String(p.location),
    starts_at: String(p.starts_at ?? ""),
    ends_at: p.ends_at == null ? null : String(p.ends_at),
    timezone: p.timezone == null ? null : String(p.timezone),
    with_call: Boolean(p.with_call),
    cancelled: Boolean(p.cancelled),
    counts: {
      going: going.length,
      maybe: maybe.length,
      not_going: notGoing.length,
    },
    my_answer: myAnswer,
    my_plus_one: myPlusOne,
    going,
    maybe,
    not_going: notGoing,
  };
}

export function buildPollPayload(input: {
  question: string;
  options: string[];
  multiple?: boolean;
}): PollPayload {
  return {
    question: input.question.trim(),
    multiple: Boolean(input.multiple),
    closed: false,
    options: input.options
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text) => ({ id: randomUUID().slice(0, 12), text, voter_ids: [] })),
  };
}

export function buildEventPayload(input: {
  title: string;
  description?: string | null;
  location?: string | null;
  starts_at: string;
  ends_at?: string | null;
  timezone?: string | null;
  with_call?: boolean;
}): EventPayload {
  return {
    title: input.title.trim(),
    description: input.description ?? null,
    location: input.location ?? null,
    starts_at: input.starts_at,
    ends_at: input.ends_at ?? null,
    timezone: input.timezone ?? null,
    with_call: Boolean(input.with_call),
    cancelled: false,
    rsvps: [],
  };
}

export function buildContactPayload(input: {
  name: string;
  phones?: string[];
  user_id?: string | null;
}): ContactPayload {
  return {
    name: input.name.trim(),
    phones: (input.phones ?? []).map(String).filter(Boolean),
    user_id: input.user_id ?? null,
  };
}

export function buildLocationPayload(input: {
  lat: number;
  lng: number;
  address?: string | null;
  name?: string | null;
  live?: boolean;
  accuracy?: number | null;
  duration_seconds?: number | null;
}): LocationPayload {
  const now = new Date();
  const live = Boolean(input.live);
  const duration = live
    ? Math.min(Math.max(Number(input.duration_seconds) || 900, 60), 8 * 3600)
    : null;
  const expiresAt =
    live && duration ? new Date(now.getTime() + duration * 1000).toISOString() : null;
  return {
    lat: input.lat,
    lng: input.lng,
    address: input.address ?? null,
    name: live ? input.name ?? "Live location" : input.name ?? null,
    live,
    accuracy: input.accuracy ?? null,
    duration_seconds: duration,
    started_at: live ? now.toISOString() : null,
    expires_at: expiresAt,
    ended: false,
    updated_at: live ? now.toISOString() : null,
  };
}

export function previewForRichType(type: MessageType, payload: unknown): string {
  const p = asRecord(payload);
  switch (type) {
    case "CONTACT":
      return p?.name ? `Contact · ${p.name}` : "Contact";
    case "LOCATION":
      if (p?.live && !p?.ended) return "Live location";
      return p?.name || p?.address ? `Location · ${p.name || p.address}` : "Location";
    case "POLL":
      return p?.question ? `Poll · ${p.question}` : "Poll";
    case "EVENT":
      return p?.title ? `Event · ${p.title}` : "Event";
    case "STICKER":
      return p?.emoji ? String(p.emoji) : "Sticker";
    default:
      return "Message";
  }
}

export function toMessageDto(msg: MessageWithExtras, viewerId?: string) {
  const deleted = Boolean(msg.deletedForEveryoneAt);
  const expired = msg.expiresAt ? msg.expiresAt.getTime() <= Date.now() : false;
  const hideBody = deleted || expired;
  const type = msg.type;
  const payload = hideBody ? null : msg.payload;

  const payloadRec = asRecord(payload);
  const isSystem = Boolean(payloadRec?.system);

  // View-once: hide media once the viewer opened it (or, for the sender, once a recipient did).
  const opens = msg.viewOnceOpens ?? [];
  const viewOnceOpened =
    msg.viewOnce &&
    !hideBody &&
    Boolean(viewerId) &&
    (viewerId === msg.senderId
      ? opens.some((o) => o.userId !== msg.senderId)
      : opens.some((o) => o.userId === viewerId));

  return {
    id: msg.id,
    conversation_id: msg.conversationId,
    sender_id: msg.senderId,
    type: type.toLowerCase(),
    text: hideBody
      ? (expired && !deleted ? "This message has disappeared" : null)
      : viewOnceOpened
        ? "Opened"
        : msg.text,
    attachment: hideBody || viewOnceOpened ? null : (msg.attachment ?? null),
    preview: hideBody ? null : (msg.preview ?? null),
    system: isSystem,
    poll: type === "POLL" && payload ? pollToDto(payload, viewerId) : null,
    event: type === "EVENT" && payload ? eventToDto(payload, viewerId) : null,
    contact:
      type === "CONTACT" && payload
        ? {
            name: String(asRecord(payload)?.name ?? ""),
            phones: (asRecord(payload)?.phones as string[]) ?? [],
            user_id: (asRecord(payload)?.user_id as string | null) ?? null,
          }
        : null,
    location:
      type === "LOCATION" && payload
        ? (() => {
            const loc = asRecord(payload) ?? {};
            const ended = Boolean(loc.ended);
            const expiresAt = loc.expires_at ? String(loc.expires_at) : null;
            const expired =
              Boolean(loc.live) &&
              !ended &&
              expiresAt != null &&
              Date.parse(expiresAt) <= Date.now();
            return {
              lat: Number(loc.lat ?? 0),
              lng: Number(loc.lng ?? 0),
              address: (loc.address as string | null) ?? null,
              name: (loc.name as string | null) ?? null,
              live: Boolean(loc.live) && !ended && !expired,
              accuracy: loc.accuracy == null ? null : Number(loc.accuracy),
              duration_seconds:
                loc.duration_seconds == null ? null : Number(loc.duration_seconds),
              started_at: loc.started_at == null ? null : String(loc.started_at),
              expires_at: expiresAt,
              ended: ended || expired,
              updated_at: loc.updated_at == null ? null : String(loc.updated_at),
            };
          })()
        : null,
    sticker:
      type === "STICKER" && payload
        ? {
            id: String(asRecord(payload)?.sticker_id ?? ""),
            emoji: String(asRecord(payload)?.emoji ?? msg.text ?? ""),
            label: (asRecord(payload)?.label as string | null) ?? null,
            pack_id: (asRecord(payload)?.pack_id as string | null) ?? null,
            url: null,
            animated: false,
          }
        : null,
    client_id: msg.clientId,
    status: msg.status.toLowerCase(),
    deleted_for_everyone_at: msg.deletedForEveryoneAt?.toISOString() ?? null,
    expires_at: msg.expiresAt?.toISOString() ?? null,
    edited_at: msg.editedAt?.toISOString() ?? null,
    view_once: msg.viewOnce,
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
  viewOnceOpens: { select: { userId: true } },
} as const;
