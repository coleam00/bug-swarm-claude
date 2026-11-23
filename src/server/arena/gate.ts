// The per-address limits on /ws (#104): at most `maxSockets` sockets open at once from one client
// address, at most `maxWatchers` of them watching at once (#119, the start screen), and at most
// `joinsPerMinute` joins (welcomed hellos) from it in any 60 s window. Only what it allows is
// counted, so a client retrying a refusal never locks itself out. An address with no open socket,
// no watcher, no join in the window and no refusal logged in the window is forgotten: at most once
// a minute, `open` sweeps the map, so addresses that come once and leave don't pile up.
// The clock is injected, so tests step it by hand. `createOpenGate` (BUG_SWARM_ALLOW_LOAD=1, load
// testing only) allows everything and keeps nothing.

/** The window the join limit and the refusal log count over, ms. */
export const GATE_WINDOW_MS = 60_000;

export type AddressGate = {
  /** Counts a socket from `addr`; false (nothing counted) at the cap. */
  open(addr: string): boolean;
  /** A counted socket from `addr` closed. Call it once per `open` that returned true. */
  close(addr: string): void;
  /** Counts a join from `addr`; false (nothing counted) at the cap. */
  join(addr: string): boolean;
  /** Counts a watcher from `addr`; false (nothing counted) at the cap. */
  watch(addr: string): boolean;
  /** A counted watcher from `addr` stopped watching. Call it once per `watch` that returned true. */
  unwatch(addr: string): void;
  /** True at most once per address per window: whether to log this refusal. */
  shouldLog(addr: string): boolean;
  /** Sockets from `addr` counted now. */
  sockets(addr: string): number;
  /** Watchers from `addr` counted now. */
  watchers(addr: string): number;
  /** Addresses remembered now (open sockets, watchers, recent joins or a recent refusal log). */
  readonly size: number;
};

type Entry = { sockets: number; watchers: number; joins: number[]; loggedAt: number };

export type GateOptions = { maxSockets: number; maxWatchers: number; joinsPerMinute: number; now?: () => number };

export function createAddressGate(opts: GateOptions): AddressGate {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let sweptAt = now();

  /** Drops the join times that left the window. */
  const trim = (e: Entry, t: number) => {
    let drop = 0;
    while (drop < e.joins.length && t - e.joins[drop]! >= GATE_WINDOW_MS) drop++;
    if (drop > 0) e.joins.splice(0, drop);
  };
  const idle = (e: Entry, t: number) => e.sockets === 0 && e.watchers === 0 && e.joins.length === 0 && t - e.loggedAt >= GATE_WINDOW_MS;
  const forgetIfIdle = (addr: string, e: Entry, t: number) => {
    trim(e, t);
    if (idle(e, t)) entries.delete(addr);
  };
  const entry = (addr: string) => {
    let e = entries.get(addr);
    if (!e) {
      e = { sockets: 0, watchers: 0, joins: [], loggedAt: -Infinity };
      entries.set(addr, e);
    }
    return e;
  };
  const sweep = (t: number) => {
    if (t - sweptAt < GATE_WINDOW_MS) return;
    sweptAt = t;
    for (const [addr, e] of entries) forgetIfIdle(addr, e, t);
  };

  return {
    open(addr) {
      const t = now();
      sweep(t);
      const e = entry(addr);
      if (e.sockets >= opts.maxSockets) return false;
      e.sockets++;
      return true;
    },
    close(addr) {
      const e = entries.get(addr);
      if (!e) return;
      e.sockets = Math.max(0, e.sockets - 1);
      forgetIfIdle(addr, e, now());
    },
    join(addr) {
      const t = now();
      const e = entry(addr);
      trim(e, t);
      if (e.joins.length >= opts.joinsPerMinute) return false;
      e.joins.push(t);
      return true;
    },
    watch(addr) {
      const e = entry(addr);
      if (e.watchers >= opts.maxWatchers) return false;
      e.watchers++;
      return true;
    },
    unwatch(addr) {
      const e = entries.get(addr);
      if (!e) return;
      e.watchers = Math.max(0, e.watchers - 1);
      forgetIfIdle(addr, e, now());
    },
    shouldLog(addr) {
      const t = now();
      const e = entry(addr);
      if (t - e.loggedAt < GATE_WINDOW_MS) return false;
      e.loggedAt = t;
      return true;
    },
    sockets(addr) {
      return entries.get(addr)?.sockets ?? 0;
    },
    watchers(addr) {
      return entries.get(addr)?.watchers ?? 0;
    },
    get size() {
      return entries.size;
    },
  };
}

/** The gate with the limits off (BUG_SWARM_ALLOW_LOAD=1, load testing only): allows everything, remembers nothing. */
export function createOpenGate(): AddressGate {
  return {
    open: () => true,
    close: () => {},
    join: () => true,
    watch: () => true,
    unwatch: () => {},
    shouldLog: () => false,
    sockets: () => 0,
    watchers: () => 0,
    size: 0,
  };
}
