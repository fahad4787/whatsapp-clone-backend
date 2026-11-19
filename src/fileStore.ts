import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "./db.js";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function mimeFor(rel: string): string {
  const ext = path.extname(rel).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Copy a freshly written upload into Postgres so it survives redeploys. */
export async function mirrorUpload(relPath: string, diskPath: string, mime?: string): Promise<void> {
  try {
    const data = await readFile(diskPath);
    await prisma.uploadedFile.upsert({
      where: { path: relPath },
      create: { path: relPath, mime: mime ?? mimeFor(relPath), data },
      update: { mime: mime ?? mimeFor(relPath), data },
    });
  } catch {
    // Disk copy still serves until the next deploy; never fail the upload over the mirror.
  }
}

export async function loadUpload(relPath: string) {
  return prisma.uploadedFile.findUnique({ where: { path: relPath } });
}
