import { readFileSync } from "node:fs";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type BatchResponse } from "firebase-admin/messaging";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { realtimeHub } from "../realtime/hub.js";

let app: App | null = null;

export function initFcm(): boolean {
  if (app) return true;
  try {
    let serviceAccount: Record<string, unknown> | undefined;
    if (config.fcmServiceAccountJson) {
      serviceAccount = JSON.parse(config.fcmServiceAccountJson) as Record<string, unknown>;
    } else if (config.fcmServiceAccountPath) {
      serviceAccount = JSON.parse(
        readFileSync(config.fcmServiceAccountPath, "utf8"),
      ) as Record<string, unknown>;
    }
    if (!serviceAccount) {
      return false;
    }
    app =
      getApps()[0] ??
      initializeApp({
        credential: cert(serviceAccount as Parameters<typeof cert>[0]),
      });
    return true;
  } catch (err) {
    console.warn("[fcm] init failed", err);
    return false;
  }
}

export function fcmEnabled(): boolean {
  return Boolean(app) || initFcm();
}

/** Notify conversation peers who are not currently connected over WebSocket. */
export async function notifyNewMessage(opts: {
  conversationId: string;
  senderId: string;
  preview: string;
  messageId: string;
}) {
  const now = new Date();
  const members = await prisma.conversationMember.findMany({
    where: {
      conversationId: opts.conversationId,
      userId: { not: opts.senderId },
    },
    select: { userId: true, mutedUntil: true },
  });
  // Push unless chat is open or muted for this member.
  const notifyUserIds = members
    .filter((m) => !m.mutedUntil || m.mutedUntil.getTime() <= now.getTime())
    .map((m) => m.userId)
    .filter((id) => !realtimeHub.isInRoom(id, opts.conversationId));
  if (notifyUserIds.length === 0) return;

  const devices = await prisma.device.findMany({
    where: {
      userId: { in: notifyUserIds },
      pushToken: { not: null },
    },
    select: { id: true, pushToken: true },
  });
  const tokens = devices
    .map((d) => d.pushToken)
    .filter((t): t is string => Boolean(t));
  if (tokens.length === 0) return;

  if (!fcmEnabled() || !app) {
    console.info("[fcm] skip send (not configured)", {
      conversationId: opts.conversationId,
      tokens: tokens.length,
      preview: opts.preview.slice(0, 80),
    });
    return;
  }

  const preview = opts.preview.slice(0, 180);
  const res: BatchResponse = await getMessaging(app).sendEachForMulticast({
    tokens,
    notification: {
      title: "Aivora",
      body: preview,
    },
    data: {
      type: "message",
      conversation_id: opts.conversationId,
      message_id: opts.messageId,
      title: "Aivora",
      preview,
    },
    android: {
      priority: "high",
      notification: {
        channelId: "messages",
        priority: "high",
        defaultSound: true,
        defaultVibrateTimings: true,
      },
    },
  });

  res.responses.forEach((r, i) => {
    if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
      const token = tokens[i];
      void prisma.device.updateMany({
        where: { pushToken: token },
        data: { pushToken: null },
      });
    }
  });
}
