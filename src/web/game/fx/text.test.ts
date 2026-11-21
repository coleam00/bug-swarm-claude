import { describe, expect, test } from "bun:test";
import {
  TEXT_CAPACITY,
  TEXT_LABELS,
  TEXT_MAX_SQUASHES,
  TEXT_MERGE_PX,
  TEXT_RISE,
  TEXT_SECONDS,
  WORD_SECONDS,
  createTexts,
  setTextScale,
  spawnText,
  spawnWord,
  textLabel,
  updateTexts,
  type Texts,
} from "./text";

/** The squash counts of the live labels. */
function counts(t: Texts): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.life.length; i++) if (t.life[i]! > 0) out.push(t.count[i]!);
  return out;
}

describe("floating text pool", () => {
  test("a label reads the points its squashes scored", () => {
    expect(TEXT_LABELS[1]).toBe("+10");
    expect(TEXT_LABELS[3]).toBe("+30");
    expect(TEXT_LABELS[TEXT_MAX_SQUASHES]).toBe("+990");
  });

  test("a label rises, then expires and frees its slot for reuse", () => {
    const t = createTexts();
    spawnText(t, 100, 200);
    updateTexts(t, 0.5);
    expect(t.y[0]).toBeCloseTo(200 - TEXT_RISE * 0.5, 3);
    expect(t.x[0]).toBe(100);
    expect(t.live).toBe(1);
    updateTexts(t, TEXT_SECONDS);
    expect(t.live).toBe(0);
    expect(t.life[0]).toBe(0);
    spawnText(t, 5, 5);
    expect(t.live).toBe(1);
    expect(t.life.length).toBe(TEXT_CAPACITY);
  });

  test("squashes close in place and time merge into one label, which lives on from the last", () => {
    const t = createTexts();
    spawnText(t, 100, 100);
    updateTexts(t, 0.1);
    spawnText(t, 110, 105);
    updateTexts(t, 0.2); // 0.3 s after the first, 0.2 s after the last merge: still merges
    spawnText(t, 95, 100);
    expect(t.live).toBe(1);
    expect(counts(t)).toEqual([3]);
    expect(t.life[0]).toBeCloseTo(TEXT_SECONDS, 5);
    expect(t.x[0]).toBe(100); // stays where it was made
  });

  test("a squash 0.3 s after a label's last merge makes a new label", () => {
    const t = createTexts();
    spawnText(t, 100, 100);
    updateTexts(t, 0.3);
    spawnText(t, 100, 100 - TEXT_RISE * 0.3);
    expect(counts(t)).toEqual([1, 1]);
  });

  test("a squash just past the merge distance makes a new label", () => {
    const t = createTexts();
    spawnText(t, 100, 100);
    spawnText(t, 100 + TEXT_MERGE_PX + 1, 100);
    expect(counts(t)).toEqual([1, 1]);
  });

  test("the merge distance is in CSS px, so it shrinks in arena units on a bigger layout", () => {
    const t = createTexts();
    setTextScale(t, 2);
    expect(t.mergeRadius).toBe(TEXT_MERGE_PX / 2);
    spawnText(t, 100, 100);
    spawnText(t, 130, 100);
    expect(counts(t)).toEqual([1, 1]);
    spawnText(t, 120, 100);
    expect(counts(t)).toEqual([1, 2]);
  });

  test("a full pool never grows, and a new label takes the one with least life left", () => {
    const t = createTexts();
    for (let i = 0; i < TEXT_CAPACITY; i++) {
      spawnText(t, i * 100, 0);
      updateTexts(t, 0.01);
    }
    // Slot 0 takes a merge, so its life restarts: slot 1 is now the one with least life left.
    spawnText(t, 0, 0);
    expect(t.count[0]).toBe(2);
    spawnText(t, 5000, 0);
    expect(t.live).toBe(TEXT_CAPACITY);
    expect(t.life.length).toBe(TEXT_CAPACITY);
    expect(t.x[1]).toBe(5000);
    expect(t.x[0]).toBe(0);
    expect(t.count[0]).toBe(2);
    expect(t.x[2]).toBe(200);
  });

  test("never more than 12 labels are alive, however many squashes land apart", () => {
    const t = createTexts();
    for (let i = 0; i < 40; i++) {
      spawnText(t, i * 100, 0);
      expect(t.live).toBeLessThanOrEqual(12);
    }
    expect(t.live).toBe(12);
  });

  test("a label stops taking squashes at the most it can show", () => {
    const t = createTexts();
    for (let i = 0; i < TEXT_MAX_SQUASHES + 1; i++) spawnText(t, 100, 100);
    expect(counts(t)).toEqual([TEXT_MAX_SQUASHES, 1]);
  });
});

describe("points other than a squash's", () => {
  test("a label shows the points it was given, and merges sum them: 15 then 10 reads +25", () => {
    const t = createTexts();
    spawnText(t, 100, 100, 15);
    expect(textLabel(t, 0)).toBe("+15");
    spawnText(t, 101, 100, 10);
    expect(textLabel(t, 0)).toBe("+25");
    expect(t.count[0]).toBe(2);
  });

  test("with no points given a squash still reads +10, as release 1 draws it", () => {
    const t = createTexts();
    spawnText(t, 100, 100);
    spawnText(t, 100, 100);
    expect(textLabel(t, 0)).toBe(TEXT_LABELS[t.count[0]!]!);
    expect(textLabel(t, 0)).toBe("+20");
  });
});

describe("word labels (#73)", () => {
  const WORDS = ["Test shield!", "Review laser!"];

  test("a word label shows its prebuilt word, lives WORD_SECONDS, and never merges either way", () => {
    const t = createTexts(TEXT_CAPACITY, WORDS);
    spawnText(t, 100, 100);
    spawnWord(t, 100, 100, 1);
    spawnText(t, 100, 100);
    spawnWord(t, 100, 100, 0);
    expect(t.live).toBe(3);
    const labels: string[] = [];
    for (let i = 0; i < t.life.length; i++) if (t.life[i]! > 0) labels.push(textLabel(t, i));
    // The second squash merged into the first label, never into the word.
    expect(labels).toEqual(["+20", "Review laser!", "Test shield!"]);
    expect(textLabel(t, 1)).toBe(WORDS[1]!);
    expect(textLabel(t, 1)).toBe(textLabel(t, 1));
    updateTexts(t, TEXT_SECONDS + 0.01);
    expect(t.live).toBe(2);
    updateTexts(t, WORD_SECONDS - TEXT_SECONDS);
    expect(t.live).toBe(0);
  });

  test("a points label reusing a word's slot reads as points again; an unknown word is ignored", () => {
    const t = createTexts(1, WORDS);
    spawnWord(t, 0, 0, 0);
    updateTexts(t, WORD_SECONDS + 0.1);
    spawnText(t, 0, 0, 25);
    expect(textLabel(t, 0)).toBe("+25");
    spawnWord(t, 0, 0, 7);
    expect(textLabel(t, 0)).toBe("+25");
  });
});
