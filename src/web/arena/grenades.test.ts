import { describe, expect, test } from "bun:test";
import { GRENADE_FLIGHT_TICKS } from "../../shared/arena/constants";
import { GRENADE_FUSE_TICKS } from "../../shared/arena/grenade";
import { GRENADE_FLASH_TICKS, addGrenade, clearGrenades, createGrenades, grenadeAt, stepGrenadeFx, type GrenadeAt } from "./grenades";

const at = (): GrenadeAt => ({ phase: 0, x: 0, y: 0, k: 0 });

describe("grenades on screen (#130)", () => {
  // Thrown in the step of tick 99, so its event's tick (the snapshot after) is 100.
  const thrown = () => {
    const g = createGrenades(4);
    addGrenade(g, 7, [100, 200, 420, 200, 100]);
    return g;
  };

  test("it flies from the thrower to its landing point, blinks there, then flashes, on the snapshot clock", () => {
    const g = thrown();
    const o = at();
    expect(grenadeAt(g, 0, 98.9, o).phase).toBe(0);
    expect(grenadeAt(g, 0, 99, o)).toEqual({ phase: 1, x: 100, y: 200, k: 0 });
    expect(grenadeAt(g, 0, 99 + GRENADE_FLIGHT_TICKS / 2, o)).toEqual({ phase: 1, x: 260, y: 200, k: 0.5 });
    expect(grenadeAt(g, 0, 99 + GRENADE_FLIGHT_TICKS, o)).toMatchObject({ phase: 2, x: 420, y: 200, k: 0 });
    // The server's blast is in the step of tick 99 + 20, so in the snapshot of tick 120.
    expect(grenadeAt(g, 0, 99 + GRENADE_FUSE_TICKS + 0.99, o).phase).toBe(2);
    expect(grenadeAt(g, 0, 100 + GRENADE_FUSE_TICKS, o)).toMatchObject({ phase: 3, k: 0 });
    expect(grenadeAt(g, 0, 100 + GRENADE_FUSE_TICKS + GRENADE_FLASH_TICKS, o).phase).toBe(0);
  });

  test("its blast shows once, at the landing point, at the thrower's clock: yours at mineAt, others' at the others'", () => {
    const blasts: [number, number][] = [];
    const on = (x: number, y: number) => blasts.push([x, y]);
    const g = thrown();
    const due = 100 + GRENADE_FUSE_TICKS;
    // Someone else's: the others' clock decides.
    stepGrenadeFx(g, 3, due + 1, due - 0.5, on);
    expect(blasts).toEqual([]);
    stepGrenadeFx(g, 3, due + 1, due, on);
    stepGrenadeFx(g, 3, due + 1, due + 1, on);
    expect(blasts).toEqual([[420, 200]]);
    stepGrenadeFx(g, 3, 0, due + GRENADE_FLASH_TICKS, on);
    expect(g.live).toBe(0);
    // Your own: your clock.
    const mine = thrown();
    stepGrenadeFx(mine, 7, due, 0, on);
    expect(blasts).toHaveLength(2);
  });

  test("a page that was away past the flash shows no late blast; a full pool overwrites the oldest; a new arena clears it", () => {
    const blasts: number[] = [];
    const g = thrown();
    stepGrenadeFx(g, 3, 0, 1000, () => blasts.push(1));
    expect([blasts, g.live]).toEqual([[], 0]);
    for (let i = 0; i < 6; i++) addGrenade(g, i, [0, 0, i, 0, 10]);
    expect(g.live).toBe(4);
    expect([...g.toX].sort()).toEqual([2, 3, 4, 5]);
    clearGrenades(g);
    expect(g.live).toBe(0);
    expect(grenadeAt(g, 0, 10, at()).phase).toBe(0);
  });
});
