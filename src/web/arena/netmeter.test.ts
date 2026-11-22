import { describe, expect, test } from "bun:test";
import { NET_WINDOW_MS, ackP95, createNetMeter, noteAck, noteSent, readKbps, resetNetMeter } from "./netmeter";

describe("the F readout's network numbers", () => {
  test("input to ack: each new ack samples the time since its input left; p95 over the window", () => {
    const m = createNetMeter();
    expect(ackP95(m, 0)).toBeNull();
    // 20 inputs, 50 ms apart; each acknowledged 40 ms later, but the 20th 200 ms later.
    for (let s = 1; s <= 20; s++) {
      noteSent(m, s, s * 50);
      noteAck(m, s, s * 50 + (s === 20 ? 200 : 40));
    }
    expect(ackP95(m, 1200)).toBe(40);
    noteAck(m, 20, 5000); // not newer: no sample
    for (let s = 21; s <= 40; s++) {
      noteSent(m, s, s * 50);
      noteAck(m, s, s * 50 + 200);
    }
    expect(ackP95(m, 2200)).toBe(200);
    // Past the window, nothing is left.
    expect(ackP95(m, 2200 + NET_WINDOW_MS + 300)).toBeNull();
  });

  test("an ack skipping inputs samples the newest; a reset starts the numbering again", () => {
    const m = createNetMeter();
    for (let s = 1; s <= 3; s++) noteSent(m, s, s * 10);
    noteAck(m, 3, 100);
    expect(ackP95(m, 100)).toBe(70);
    resetNetMeter(m);
    noteSent(m, 1, 500);
    noteAck(m, 1, 530);
    expect(ackP95(m, 530)).toBe(30);
  });

  test("KB/s: bytes since the oldest reading within the window", () => {
    const m = createNetMeter();
    expect(readKbps(m, 0, 0)).toBeNull();
    expect(readKbps(m, 15_000, 500)).toBe(30);
    expect(readKbps(m, 30_000, 1000)).toBe(30);
    expect(readKbps(m, 60_000, 1500)).toBe(40);
    expect(readKbps(m, 80_000, 2000)).toBe(40);
    // The reading at 0 has left the window: from 500 on.
    expect(readKbps(m, 80_000 + 30_000, 2500)).toBe(47.5);
  });
});
