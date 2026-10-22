import { config } from "./config.js";

export function publicUrl(relativePath: string): string {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  return `${base}${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}`;
}
