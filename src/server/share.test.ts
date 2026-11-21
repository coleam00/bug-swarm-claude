import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_IMAGE_ATTR, requestOrigin, withAbsoluteImages } from "./share";

const headers = (h: Record<string, string>) => (name: string) => h[name];

describe("requestOrigin", () => {
  test("Host alone gives http", () => {
    expect(requestOrigin(headers({ host: "127.0.0.1:3000" }))).toBe("http://127.0.0.1:3000");
  });
  test("behind a proxy: the forwarded host and proto win", () => {
    expect(requestOrigin(headers({ host: "10.0.0.5:8080", "x-forwarded-host": "bugswarm.example", "x-forwarded-proto": "https" }))).toBe(
      "https://bugswarm.example",
    );
  });
  test("takes the rightmost forwarded entry, the one the nearest proxy wrote", () => {
    expect(requestOrigin(headers({ "x-forwarded-host": "forged.example, bugswarm.example", "x-forwarded-proto": "http, https" }))).toBe(
      "https://bugswarm.example",
    );
  });
  test("an unknown proto falls back to http", () => {
    expect(requestOrigin(headers({ host: "bugswarm.example", "x-forwarded-proto": "javascript" }))).toBe("http://bugswarm.example");
  });
  test("a hostile or missing host gives null", () => {
    expect(requestOrigin(headers({ host: 'evil"><script>alert(1)</script>' }))).toBeNull();
    expect(requestOrigin(headers({ host: "a.example/path" }))).toBeNull();
    expect(requestOrigin(headers({}))).toBeNull();
  });
});

describe("withAbsoluteImages", () => {
  const html = `<meta property="og:image" ${PREVIEW_IMAGE_ATTR} /><meta name="twitter:image" ${PREVIEW_IMAGE_ATTR} />`;
  test("makes og:image and twitter:image absolute", () => {
    expect(withAbsoluteImages(html, "https://bugswarm.example")).toBe(
      '<meta property="og:image" content="https://bugswarm.example/og.png" /><meta name="twitter:image" content="https://bugswarm.example/og.png" />',
    );
  });
  test("leaves the page as it is when the origin is unknown", () => {
    expect(withAbsoluteImages(html, null)).toBe(html);
  });
});

// The page's share tags and gestures. Its layout is measured in a browser (engineering.md); this
// only pins what a browser on a desktop can't show, such as -webkit-touch-callout.
describe("index.html", () => {
  const page = readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8");
  /** The declarations of the rule for `selector` that sets `property`. */
  const css = page.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string, property: string) =>
    [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1]!.trim() === selector && m[2]!.includes(property))?.[2] ?? "";

  test("has the description, Open Graph and Twitter card tags", () => {
    expect(page).toContain('<meta name="description" content="');
    expect(page).toContain('<meta property="og:title" content="Bug Swarm" />');
    expect(page).toContain('<meta property="og:description" content="');
    expect(page).toContain(`<meta property="og:image" ${PREVIEW_IMAGE_ATTR} />`);
    expect(page).toContain(`<meta name="twitter:image" ${PREVIEW_IMAGE_ATTR} />`);
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  test("links the generated icons", () => {
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(page).toContain('<link rel="alternate icon" href="/favicon.ico" />');
    expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });

  test("game UI takes no selection, long-press menu or double-tap zoom; the name input still selects", () => {
    const body = rule("html, body", "user-select");
    for (const decl of ["-webkit-user-select: none", " user-select: none", "-webkit-touch-callout: none", "touch-action: manipulation"]) {
      expect(body).toContain(decl);
    }
    const input = rule(".setup input", "user-select");
    expect(input).toContain("-webkit-user-select: text");
    expect(input).toContain(" user-select: text");
  });
});
