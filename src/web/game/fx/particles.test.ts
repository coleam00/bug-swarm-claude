import { describe, expect, test } from "bun:test";
import { createRng } from "../rng";
import { PARTICLE_CAPACITY, createParticles, spawnBurst, updateParticles } from "./particles";

describe("particle pool", () => {
  test("a burst fills free slots and they move outward", () => {
    const p = createParticles();
    spawnBurst(p, 100, 100, 14, 2, createRng(1));
    expect(p.live).toBe(14);
    updateParticles(p, 0.1);
    for (let i = 0; i < 14; i++) {
      expect(Math.hypot(p.x[i]! - 100, p.y[i]! - 100)).toBeGreaterThan(0);
      expect(p.colour[i]).toBe(2);
    }
  });

  test("expired particles free their slots, and the next burst reuses them", () => {
    const p = createParticles(16);
    const x = p.x;
    spawnBurst(p, 0, 0, 16, 0, createRng(1));
    for (let i = 0; i < 10; i++) updateParticles(p, 0.1); // 1 s, past every particle's life
    expect(p.live).toBe(0);
    for (let i = 0; i < 16; i++) expect(p.life[i]).toBe(0);
    spawnBurst(p, 50, 50, 16, 0, createRng(2));
    expect(p.live).toBe(16);
    expect(p.x).toBe(x); // the same arrays: nothing was reallocated
    expect(p.x.length).toBe(16);
  });

  test("a full pool overwrites its oldest particles and never grows", () => {
    const p = createParticles();
    const rng = createRng(1);
    spawnBurst(p, 1, 1, PARTICLE_CAPACITY, 0, rng);
    spawnBurst(p, 2, 2, 50, 1, rng);
    expect(p.live).toBe(PARTICLE_CAPACITY);
    expect(p.life.length).toBe(PARTICLE_CAPACITY);
    let newest = 0;
    let oldest = 0;
    for (let i = 0; i < PARTICLE_CAPACITY; i++) {
      if (p.colour[i] === 1) newest++;
      else oldest++;
    }
    expect(newest).toBe(50);
    expect(oldest).toBe(PARTICLE_CAPACITY - 50);
    // The overwritten ones are the first 50 spawned.
    for (let i = 0; i < 50; i++) expect(p.x[i]).toBe(2);
  });

  test("the same seed sprays the same way", () => {
    const a = createParticles();
    const b = createParticles();
    spawnBurst(a, 0, 0, 14, 0, createRng(7));
    spawnBurst(b, 0, 0, 14, 0, createRng(7));
    expect(Array.from(a.vx)).toEqual(Array.from(b.vx));
    expect(Array.from(a.life)).toEqual(Array.from(b.life));
  });
});
