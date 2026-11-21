// Link previews need an absolute image URL, and the app knows no public URL of its own
// (architecture.md: it honors only PORT and DATA_DIR). So the served page gets the origin of the
// request it answers. Pure, so it is tested without a server; main.ts does the wiring.

/** How index.html names the preview image; the served page makes it absolute. */
export const PREVIEW_IMAGE_ATTR = 'content="/og.png"';

const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/** The last comma-separated entry: the one the nearest proxy wrote. */
const rightmost = (v: string | null | undefined) => v?.split(",").pop()?.trim() || undefined;

/**
 * "proto://host" of the request, from X-Forwarded-Host or Host, and X-Forwarded-Proto (http or
 * https, else http). Null when the host is missing or not a plain host name: it goes into HTML.
 */
export function requestOrigin(header: (name: string) => string | null | undefined): string | null {
  const host = rightmost(header("x-forwarded-host")) ?? header("host")?.trim();
  if (!host || !HOST.test(host)) return null;
  const sent = rightmost(header("x-forwarded-proto"))?.toLowerCase();
  const proto = sent === "https" || sent === "http" ? sent : "http";
  return `${proto}://${host}`;
}

/** The page with its preview image URLs made absolute, or as it is when the origin is unknown. */
export function withAbsoluteImages(html: string, origin: string | null): string {
  return origin ? html.replaceAll(PREVIEW_IMAGE_ATTR, `content="${origin}/og.png"`) : html;
}
