import { expect, test } from "bun:test";
import { WORLD_H, WORLD_W } from "../../shared/arena/constants";
import { NO_INSETS } from "../game/hud";
import { MINIMAP_DESKTOP, MINIMAP_MARGIN, MINIMAP_PHONE, minimapLayout, toMinimap } from "./minimap";

test("top-right, inside the safe area, smaller on a phone", () => {
  expect(minimapLayout(1440, 900, NO_INSETS)).toEqual({ x: 1440 - MINIMAP_MARGIN - MINIMAP_DESKTOP, y: MINIMAP_MARGIN, size: MINIMAP_DESKTOP });
  expect(minimapLayout(844, 390, { top: 0, right: 47, bottom: 21, left: 47 })).toEqual({
    x: 844 - 47 - MINIMAP_MARGIN - MINIMAP_PHONE,
    y: MINIMAP_MARGIN,
    size: MINIMAP_PHONE,
  });
  expect(minimapLayout(390, 844, { top: 47, right: 0, bottom: 34, left: 0 }).y).toBe(47 + MINIMAP_MARGIN);
});

test("the world's corners and centre land on the square's corners and centre", () => {
  const m = minimapLayout(1440, 900, NO_INSETS);
  const o = { x: 0, y: 0 };
  toMinimap(m, 0, 0, o);
  expect(o).toEqual({ x: m.x, y: m.y });
  toMinimap(m, WORLD_W, WORLD_H, o);
  expect(o).toEqual({ x: m.x + m.size, y: m.y + m.size });
  toMinimap(m, WORLD_W / 2, WORLD_H / 2, o);
  expect(o).toEqual({ x: m.x + m.size / 2, y: m.y + m.size / 2 });
});
