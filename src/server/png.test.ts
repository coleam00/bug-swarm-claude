import { describe, expect, test } from "bun:test";
import { crc32, inflateSync } from "node:zlib";
import { encodeIco, encodePng } from "./png";

type Chunk = { type: string; data: Uint8Array; crcOk: boolean };

function chunks(png: Uint8Array): Chunk[] {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  for (let at = 8; at < png.length; ) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    out.push({ type, data, crcOk: crc32(png.subarray(at + 4, at + 8 + len)) === v.getUint32(at + 8 + len) });
    at += 12 + len;
  }
  return out;
}

describe("encodePng", () => {
  // 2x2: red, green / blue, half-transparent white.
  const pixels = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
  const png = encodePng(2, 2, pixels);

  test("starts with the PNG signature and has IHDR, IDAT and IEND with good CRCs", () => {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const cs = chunks(png);
    expect(cs.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(cs.every((c) => c.crcOk)).toBe(true);
  });

  test("IHDR holds the size, 8-bit RGBA", () => {
    const ihdr = chunks(png)[0]!.data;
    const v = new DataView(ihdr.buffer, ihdr.byteOffset);
    expect([v.getUint32(0), v.getUint32(4), ihdr[8], ihdr[9]]).toEqual([2, 2, 8, 6]);
  });

  test("the pixels round-trip, each row behind a 0 filter byte", () => {
    const raw = inflateSync(chunks(png)[1]!.data);
    expect(raw.length).toBe(2 * (1 + 2 * 4));
    expect([...raw]).toEqual([0, ...pixels.subarray(0, 8), 0, ...pixels.subarray(8)]);
  });

  test("refuses a buffer of the wrong size", () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow();
  });
});

describe("encodeIco", () => {
  test("one 32-bit entry of the given size, with the PNG at offset 22", () => {
    const png = encodePng(1, 1, Uint8Array.from([1, 2, 3, 255]));
    const ico = encodeIco(png, 48);
    const v = new DataView(ico.buffer);
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)]).toEqual([0, 1, 1]);
    expect([ico[6], ico[7], v.getUint16(10, true), v.getUint16(12, true)]).toEqual([48, 48, 1, 32]);
    expect([v.getUint32(14, true), v.getUint32(18, true)]).toEqual([png.length, 22]);
    expect([...ico.subarray(22)]).toEqual([...png]);
    expect(encodeIco(png, 256)[6]).toBe(0);
  });
});
