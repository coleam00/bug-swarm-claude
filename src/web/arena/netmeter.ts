// The network half of the F readout (#89): what the socket receives, in KB/s, and how long an
// input takes to come back acknowledged (sent, applied by a server tick, and its snapshot back),
// p95 in ms, both over the last NET_WINDOW_MS. Pure: times come in as numbers, and it allocates
// nothing after it is made (fixed rings), so the frame loop can feed it.

/** The window both readings cover, ms. */
export const NET_WINDOW_MS = 2000;
/** Inputs remembered by sequence number (20 a second, so 3 s of them). */
const SENT = 64;
/** Acknowledgement times kept (20 a second for NET_WINDOW_MS, with room). */
const ACKS = 64;
/** Readings of the received count kept (one per F readout refresh, every 0.5 s). */
const READS = 8;

export type NetMeter = {
  sentSeq: Int32Array;
  sentAt: Float64Array;
  /** The highest sequence number acknowledged so far. */
  acked: number;
  ackMs: Float64Array;
  ackAt: Float64Array;
  ackHead: number;
  scratch: Float64Array;
  readBytes: Float64Array;
  readAt: Float64Array;
  readHead: number;
};

export function createNetMeter(): NetMeter {
  return {
    sentSeq: new Int32Array(SENT).fill(-1),
    sentAt: new Float64Array(SENT),
    acked: 0,
    ackMs: new Float64Array(ACKS),
    ackAt: new Float64Array(ACKS).fill(-Infinity),
    ackHead: 0,
    scratch: new Float64Array(ACKS),
    readBytes: new Float64Array(READS),
    readAt: new Float64Array(READS).fill(-Infinity),
    readHead: 0,
  };
}

/** A new connection: sequence numbers start again. */
export function resetNetMeter(m: NetMeter): void {
  m.sentSeq.fill(-1);
  m.acked = 0;
  m.ackAt.fill(-Infinity);
}

/** Input `seq` left at `nowMs`. */
export function noteSent(m: NetMeter, seq: number, nowMs: number): void {
  m.sentSeq[seq % SENT] = seq;
  m.sentAt[seq % SENT] = nowMs;
}

/** A snapshot acknowledging inputs up to `ack` arrived at `nowMs`: one sample for the newest. */
export function noteAck(m: NetMeter, ack: number, nowMs: number): void {
  if (ack <= m.acked) return;
  m.acked = ack;
  if (m.sentSeq[ack % SENT] !== ack) return;
  m.ackMs[m.ackHead] = nowMs - m.sentAt[ack % SENT]!;
  m.ackAt[m.ackHead] = nowMs;
  m.ackHead = (m.ackHead + 1) % ACKS;
}

/** The p95 of the acknowledgement times in the window, ms, or null with none. */
export function ackP95(m: NetMeter, nowMs: number): number | null {
  let n = 0;
  for (let i = 0; i < ACKS; i++) if (nowMs - m.ackAt[i]! <= NET_WINDOW_MS) m.scratch[n++] = m.ackMs[i]!;
  if (n === 0) return null;
  const s = m.scratch.subarray(0, n).sort();
  return s[Math.min(n - 1, Math.ceil(n * 0.95) - 1)]!;
}

/**
 * Records `bytes` (the connection's running total) at `nowMs` and returns KB/s (1 KB = 1000 B)
 * since the oldest reading in the window, or null until there are two.
 */
export function readKbps(m: NetMeter, bytes: number, nowMs: number): number | null {
  let oldest = -1;
  for (let i = 0; i < READS; i++) {
    const age = nowMs - m.readAt[i]!;
    if (age > 0 && age <= NET_WINDOW_MS + 1 && (oldest < 0 || m.readAt[i]! < m.readAt[oldest]!)) oldest = i;
  }
  m.readBytes[m.readHead] = bytes;
  m.readAt[m.readHead] = nowMs;
  m.readHead = (m.readHead + 1) % READS;
  if (oldest < 0) return null;
  return (bytes - m.readBytes[oldest]!) / (nowMs - m.readAt[oldest]!);
}
