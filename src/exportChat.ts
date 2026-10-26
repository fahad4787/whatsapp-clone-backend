import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Prisma } from "@prisma/client";
import { ZipArchive } from "archiver";

type Attachment = {
  url?: string;
  key?: string;
  mime?: string;
  name?: string;
} | null;

type ExportMessage = {
  id: string;
  type: string;
  text: string | null;
  attachment: Prisma.JsonValue | null;
  payload: Prisma.JsonValue | null;
  deletedForEveryoneAt: Date | null;
  expiresAt: Date | null;
  viewOnce: boolean;
  createdAt: Date;
  senderId: string;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** WhatsApp-style timestamp: [DD/MM/YYYY, HH:MM:SS] */
export function formatExportTs(d: Date): string {
  return `[${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function attachmentOf(m: ExportMessage): Attachment {
  return (m.attachment as Attachment) ?? null;
}

function mediaFileName(att: NonNullable<Attachment>, fallback: string): string {
  const raw = att.name?.trim() || att.key?.split("/").pop() || fallback;
  return raw.replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120);
}

/** Resolve local disk path under uploads/ when the attachment lives on this server. */
export function localUploadPath(att: NonNullable<Attachment>): string | null {
  const key = att.key?.trim();
  if (key && !key.includes("..") && !path.isAbsolute(key)) {
    const p = path.join(process.cwd(), "uploads", "media", key);
    if (existsSync(p)) return p;
  }
  const url = att.url ?? "";
  const marker = "/uploads/media/";
  const idx = url.indexOf(marker);
  if (idx >= 0) {
    const rest = decodeURIComponent(url.slice(idx + marker.length).split("?")[0] ?? "");
    if (rest && !rest.includes("..")) {
      const p = path.join(process.cwd(), "uploads", "media", rest);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function lineBody(m: ExportMessage, includeMedia: boolean, mediaZipName: string | null): string {
  if (m.deletedForEveryoneAt) return "This message was deleted";
  if (m.expiresAt && m.expiresAt.getTime() <= Date.now()) return "This message has disappeared";

  const att = attachmentOf(m);
  const payload = asRecord(m.payload);

  switch (m.type) {
    case "TEXT":
      return m.text?.trim() || "";
    case "IMAGE":
    case "VIDEO":
    case "AUDIO":
    case "DOCUMENT":
    case "STICKER": {
      if (m.viewOnce) return "View once media";
      const label = mediaZipName
        ? `<attached: ${mediaZipName}>`
        : att?.url && includeMedia
          ? `<media: ${att.url}>`
          : `<${m.type.toLowerCase()} omitted>`;
      const caption = m.text?.trim();
      return caption ? `${label} ${caption}` : label;
    }
    case "LOCATION": {
      const lat = Number(payload?.lat ?? 0);
      const lng = Number(payload?.lng ?? 0);
      const name = String(payload?.name ?? payload?.address ?? "Location");
      return `📍 ${name} (${lat}, ${lng})`;
    }
    case "CONTACT": {
      const name = String(payload?.name ?? "Contact");
      const phones = Array.isArray(payload?.phones) ? (payload.phones as string[]).join(", ") : "";
      return phones ? `👤 ${name}: ${phones}` : `👤 ${name}`;
    }
    case "POLL": {
      const q = String(payload?.question ?? "Poll");
      return `📊 Poll: ${q}`;
    }
    case "EVENT": {
      const title = String(payload?.title ?? "Event");
      return `📅 Event: ${title}`;
    }
    default:
      return m.text?.trim() || `<${m.type.toLowerCase()}>`;
  }
}

export type BuiltExport = {
  text: string;
  /** Relative names inside the zip → absolute paths (only when includeMedia). */
  mediaFiles: { zipName: string; absPath: string }[];
  title: string;
};

export function buildChatExport(opts: {
  title: string;
  messages: ExportMessage[];
  senderName: (senderId: string) => string;
  includeMedia: boolean;
}): BuiltExport {
  const mediaFiles: BuiltExport["mediaFiles"] = [];
  const usedNames = new Set<string>();
  const lines: string[] = [];

  for (const m of opts.messages) {
    const name = opts.senderName(m.senderId);
    let zipName: string | null = null;
    const att = attachmentOf(m);
    const isMedia =
      opts.includeMedia &&
      !m.viewOnce &&
      !m.deletedForEveryoneAt &&
      !(m.expiresAt && m.expiresAt.getTime() <= Date.now()) &&
      att &&
      ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "STICKER"].includes(m.type);

    if (isMedia && att) {
      const abs = localUploadPath(att);
      if (abs) {
        let base = mediaFileName(att, `${m.id}`);
        if (usedNames.has(base)) {
          const ext = path.extname(base);
          const stem = ext ? base.slice(0, -ext.length) : base;
          base = `${stem}_${m.id.slice(0, 8)}${ext}`;
        }
        usedNames.add(base);
        zipName = `media/${base}`;
        mediaFiles.push({ zipName, absPath: abs });
      }
    }

    const body = lineBody(m, opts.includeMedia, zipName?.replace(/^media\//, "") ?? null);
    if (!body) continue;
    lines.push(`${formatExportTs(m.createdAt)} ${name}: ${body}`);
  }

  const header = `Aivora Chat Export: ${opts.title}\nExported: ${new Date().toISOString()}\n\n`;
  return { text: header + lines.join("\n") + (lines.length ? "\n" : ""), mediaFiles, title: opts.title };
}

export function safeExportBasename(title: string): string {
  const cleaned = title.replace(/[^\w.\-()+ ]+/g, "_").trim().slice(0, 60);
  return cleaned || "chat";
}

/** Stream a zip (PassThrough) containing `_chat.txt` and optional media files. */
export function createExportZipStream(built: BuiltExport): PassThrough {
  const pass = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 5 } });
  archive.on("error", (err: Error) => pass.destroy(err));
  archive.pipe(pass);
  archive.append(built.text, { name: "_chat.txt" });
  for (const f of built.mediaFiles) {
    archive.append(createReadStream(f.absPath), { name: f.zipName });
  }
  void archive.finalize();
  return pass;
}
