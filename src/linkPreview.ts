/** Lightweight URL unfurl for Wave 12.5 — title + host only, no heavy scraping. */

const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function firstUrlInText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(URL_RE);
  return m?.[0]?.replace(/[),.;]+$/, "") ?? null;
}

export async function unfurlUrl(url: string): Promise<{
  url: string;
  title: string | null;
  description: string | null;
  site: string | null;
  image_url: string | null;
} | null> {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "AivoraPreview/1.0",
        accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        url,
        title: parsed.hostname,
        description: null,
        site: parsed.hostname,
        image_url: null,
      };
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/html") && !ctype.includes("xhtml")) {
      return {
        url,
        title: parsed.hostname,
        description: null,
        site: parsed.hostname,
        image_url: null,
      };
    }
    const html = (await res.text()).slice(0, 120_000);
    const ogTitle =
      metaContent(html, "og:title") ||
      titleTag(html) ||
      parsed.hostname;
    const ogDesc = metaContent(html, "og:description") || metaContent(html, "description");
    const ogImage = metaContent(html, "og:image");
    const site = metaContent(html, "og:site_name") || parsed.hostname;
    return {
      url,
      title: ogTitle?.slice(0, 200) ?? null,
      description: ogDesc?.slice(0, 300) ?? null,
      site: site?.slice(0, 100) ?? null,
      image_url: ogImage?.slice(0, 2000) ?? null,
    };
  } catch {
    return null;
  }
}

function metaContent(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
    "i",
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
    "i",
  );
  return html.match(re)?.[1] ?? html.match(re2)?.[1] ?? null;
}

function titleTag(html: string): string | null {
  return html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null;
}
