import { AccessToken } from "livekit-server-sdk";

function envUrl() {
  return process.env.LIVEKIT_URL?.trim() ?? "";
}
function envKey() {
  return process.env.LIVEKIT_API_KEY?.trim() ?? "";
}
function envSecret() {
  return process.env.LIVEKIT_API_SECRET?.trim() ?? "";
}

export function livekitConfigured(): boolean {
  return Boolean(envUrl() && envKey() && envSecret());
}

/** Mint a short-lived join token for a participant identity (use opaque user ids). */
export async function mintLivekitToken(opts: {
  roomName: string;
  identity: string;
  name?: string;
  ttlSec?: number;
}): Promise<string> {
  if (!livekitConfigured()) {
    throw new Error("livekit_not_configured");
  }
  const at = new AccessToken(envKey(), envSecret(), {
    identity: opts.identity,
    name: opts.name,
    ttl: opts.ttlSec ?? 60 * 60,
  });
  at.addGrant({
    roomJoin: true,
    room: opts.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

export function livekitUrl(): string {
  return envUrl();
}
