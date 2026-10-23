/** Shared MIME → message type / extension helpers for Wave 12. */

const IMAGE = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const AUDIO = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
]);

const VIDEO = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/3gpp",
]);

const FILE = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "application/zip",
  "application/x-zip-compressed",
]);

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function isAllowedMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return (
    IMAGE.has(m) ||
    AUDIO.has(m) ||
    VIDEO.has(m) ||
    FILE.has(m) ||
    m.startsWith("image/") ||
    m.startsWith("audio/") ||
    m.startsWith("video/")
  );
}

export type RichMessageType = "IMAGE" | "AUDIO" | "FILE" | "VIDEO" | "TEXT";

export function messageTypeFromMime(mime: string | undefined | null): RichMessageType {
  if (!mime) return "FILE";
  const m = mime.toLowerCase();
  if (IMAGE.has(m) || m.startsWith("image/")) return "IMAGE";
  if (AUDIO.has(m) || m.startsWith("audio/")) return "AUDIO";
  if (VIDEO.has(m) || m.startsWith("video/")) return "VIDEO";
  return "FILE";
}

export function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("m4a") || m === "audio/mp4" || m === "audio/aac") return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm") && m.startsWith("audio/")) return "webm";
  if (m === "video/mp4") return "mp4";
  if (m === "video/quicktime") return "mov";
  if (m === "video/webm") return "webm";
  if (m === "application/pdf") return "pdf";
  if (m.includes("wordprocessingml") || m === "application/msword") return "docx";
  if (m.includes("spreadsheetml") || m.includes("excel")) return "xlsx";
  if (m.includes("presentationml") || m.includes("powerpoint")) return "pptx";
  if (m === "text/plain") return "txt";
  if (m.includes("zip")) return "zip";
  return "bin";
}

export function previewForType(type: RichMessageType, name?: string | null): string {
  switch (type) {
    case "IMAGE":
      return "Photo";
    case "AUDIO":
      return "Voice message";
    case "VIDEO":
      return "Video";
    case "FILE":
      return name?.trim() || "Document";
    default:
      return "Message";
  }
}
