import type { WebSocket } from "ws";

export type RealtimeFrame = {
  type: string;
  data?: unknown;
};

type SocketMeta = {
  userId: string;
  rooms: Set<string>;
};

/** In-process room hub (single Render instance is enough for Wave 5). */
class RealtimeHub {
  private readonly meta = new Map<WebSocket, SocketMeta>();
  private readonly byUser = new Map<string, Set<WebSocket>>();
  private readonly rooms = new Map<string, Set<WebSocket>>();

  attach(socket: WebSocket, userId: string) {
    this.meta.set(socket, { userId, rooms: new Set() });
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(socket);
  }

  detach(socket: WebSocket) {
    const info = this.meta.get(socket);
    if (!info) return;
    for (const room of [...info.rooms]) {
      this.leaveRoom(socket, room);
    }
    this.meta.delete(socket);
    const set = this.byUser.get(info.userId);
    if (set) {
      set.delete(socket);
      if (set.size === 0) this.byUser.delete(info.userId);
    }
  }

  userId(socket: WebSocket): string | null {
    return this.meta.get(socket)?.userId ?? null;
  }

  roomsOf(socket: WebSocket): string[] {
    return [...(this.meta.get(socket)?.rooms ?? [])];
  }

  isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  /** True if the user currently has a socket joined to this conversation (chat open). */
  isInRoom(userId: string, conversationId: string): boolean {
    const sockets = this.byUser.get(userId);
    if (!sockets) return false;
    for (const socket of sockets) {
      if (this.meta.get(socket)?.rooms.has(conversationId)) return true;
    }
    return false;
  }

  /** Distinct user ids currently joined to a conversation room. */
  onlineUserIdsInRoom(conversationId: string): string[] {
    const room = this.rooms.get(conversationId);
    if (!room) return [];
    const ids = new Set<string>();
    for (const socket of room) {
      const uid = this.userId(socket);
      if (uid) ids.add(uid);
    }
    return [...ids];
  }

  joinRoom(socket: WebSocket, conversationId: string) {
    const info = this.meta.get(socket);
    if (!info) return;
    info.rooms.add(conversationId);
    let room = this.rooms.get(conversationId);
    if (!room) {
      room = new Set();
      this.rooms.set(conversationId, room);
    }
    room.add(socket);
  }

  leaveRoom(socket: WebSocket, conversationId: string) {
    const info = this.meta.get(socket);
    info?.rooms.delete(conversationId);
    const room = this.rooms.get(conversationId);
    if (!room) return;
    room.delete(socket);
    if (room.size === 0) this.rooms.delete(conversationId);
  }

  send(socket: WebSocket, frame: RealtimeFrame) {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  /** Broadcast to everyone in a conversation room (optionally skip a user). */
  toRoom(conversationId: string, frame: RealtimeFrame, exceptUserId?: string) {
    const room = this.rooms.get(conversationId);
    if (!room) return;
    for (const socket of room) {
      const uid = this.userId(socket);
      if (!uid || (exceptUserId && uid === exceptUserId)) continue;
      this.send(socket, frame);
    }
  }

  /** Deliver to all sockets for a user (any room). */
  toUser(userId: string, frame: RealtimeFrame) {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const socket of set) {
      this.send(socket, frame);
    }
  }

  /** For tests — wipe state between cases. */
  reset() {
    this.meta.clear();
    this.byUser.clear();
    this.rooms.clear();
  }
}

export const realtimeHub = new RealtimeHub();
