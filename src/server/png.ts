// A tiny PNG and ICO encoder for the icons and the link preview the app draws in code (art.ts).
// Pure: bytes in, bytes out. No filtering beyond "none"; deflate does the work.
import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGBA PNG of `width` x `height` from `rgba` (4 bytes a pixel, rows top to bottom). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array<ArrayBuffer> {
  if (rgba.length !== width * height * 4) throw new Error("encodePng: rgba is not width*height*4 bytes");
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // compression, filter and interlace methods stay 0

  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }

  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A one-image .ico that wraps a square PNG of `size` pixels (every browser reads PNG-in-ICO). */
export function encodeIco(png: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(22 + png.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0, true); // reserved
  v.setUint16(2, 1, true); // type: icon
  v.setUint16(4, 1, true); // one image
  out[6] = size >= 256 ? 0 : size; // width (0 means 256)
  out[7] = size >= 256 ? 0 : size; // height
  out[8] = 0; // no palette
  out[9] = 0; // reserved
  v.setUint16(10, 1, true); // colour planes
  v.setUint16(12, 32, true); // bits per pixel
  v.setUint32(14, png.length, true);
  v.setUint32(18, 22, true); // offset of the image
  out.set(png, 22);
  return out;
}
