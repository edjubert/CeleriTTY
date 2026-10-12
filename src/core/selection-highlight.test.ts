import { describe, expect, it } from "vitest";
import { WORDS_PER_CELL } from "../renderer/instance-data";
import { applySelectionHighlight } from "./selection-highlight";
import type { CellPoint } from "./types";

function emptyGrid(columns: number, lines: number): Uint32Array {
  return new Uint32Array(columns * lines * WORDS_PER_CELL);
}

const FLAG_INVERSE = 1;

describe("applySelectionHighlight", () => {
  it("marks every cell in a single-line range as inverse", () => {
    const packed = emptyGrid(10, 2);
    const start: CellPoint = { line: 0, column: 2 };
    const end: CellPoint = { line: 0, column: 4 };
    applySelectionHighlight(packed, 10, start, end);

    const flagsAt = (line: number, column: number): number =>
      packed[(line * 10 + column) * WORDS_PER_CELL + 3] ?? 0;

    expect(flagsAt(0, 1) & FLAG_INVERSE).toBe(0);
    expect(flagsAt(0, 2) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(0, 3) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(0, 4) & FLAG_INVERSE).toBe(FLAG_INVERSE);
  });
  it("spans multiple lines, covering full width on interior lines", () => {
    const packed = emptyGrid(4, 3);
    applySelectionHighlight(packed, 4, { line: 0, column: 2 }, { line: 1, column: 1 });

    const flagsAt = (line: number, column: number): number =>
      packed[(line * 4 + column) * WORDS_PER_CELL + 3] ?? 0;

    // Line 0: columns 2-3, i.e. to the end of the row.
    expect(flagsAt(0, 1) & FLAG_INVERSE).toBe(0);
    expect(flagsAt(0, 2) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(0, 3) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    // Line 1: columns 0-1 only, up to the end point.
    expect(flagsAt(1, 0) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(1, 1) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(1, 2) & FLAG_INVERSE).toBe(0);
  });
  it("does nothing when there is no active selection", () => {
    const packed = emptyGrid(4, 2);
    applySelectionHighlight(packed, 4, null, null);
    expect(packed.every((word) => word === 0)).toBe(true);
  });
  it("normalizes a start/end pair given in reverse order", () => {
    const packed = emptyGrid(10, 1);
    applySelectionHighlight(packed, 10, { line: 0, column: 4 }, { line: 0, column: 2 });

    const flagsAt = (column: number): number => packed[column * WORDS_PER_CELL + 3] ?? 0;
    expect(flagsAt(2) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(3) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(4) & FLAG_INVERSE).toBe(FLAG_INVERSE);
  });
});

it("bounds stale or outside anchors before walking a resized snapshot", () => {
  const packed = emptyGrid(3, 2);
  applySelectionHighlight(packed, 3, { line: 1e9, column: 1e9 }, { line: -10, column: -10 });
  for (let cell = 0; cell < 6; cell++) expect(packed[cell * WORDS_PER_CELL + 3]).toBe(FLAG_INVERSE);
  applySelectionHighlight(packed, 0, { line: 0, column: 0 }, { line: 1, column: 1 });
  applySelectionHighlight(packed, 3, { line: NaN, column: 0 }, { line: 1, column: 1 });
});

describe("applySelectionHighlight with off-screen anchors", () => {
  const flagsAt = (packed: Uint32Array, columns: number, line: number, column: number): number =>
    packed[(line * columns + column) * WORDS_PER_CELL + 3] ?? 0;

  it("paints nothing when the selection is entirely above the viewport", () => {
    const packed = emptyGrid(4, 3);
    applySelectionHighlight(packed, 4, { line: -5, column: 0 }, { line: -1, column: 3 });
    for (let line = 0; line < 3; line++)
      for (let column = 0; column < 4; column++)
        expect(flagsAt(packed, 4, line, column) & FLAG_INVERSE).toBe(0);
  });

  it("paints nothing when the selection is entirely below the viewport", () => {
    const packed = emptyGrid(4, 3);
    applySelectionHighlight(packed, 4, { line: 5, column: 0 }, { line: 8, column: 3 });
    for (let line = 0; line < 3; line++)
      for (let column = 0; column < 4; column++)
        expect(flagsAt(packed, 4, line, column) & FLAG_INVERSE).toBe(0);
  });

  it("paints only the visible part when the selection straddles the top edge", () => {
    const packed = emptyGrid(4, 3);
    // Selection from line -2 to line 1: only lines 0-1 are visible.
    applySelectionHighlight(packed, 4, { line: -2, column: 1 }, { line: 1, column: 2 });
    // Line 0: full width (interior line of the selection).
    for (let column = 0; column < 4; column++)
      expect(flagsAt(packed, 4, 0, column) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    // Line 1: columns 0-2 (up to the end point).
    expect(flagsAt(packed, 4, 1, 0) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(packed, 4, 1, 2) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(packed, 4, 1, 3) & FLAG_INVERSE).toBe(0);
    // Line 2: not part of the selection.
    for (let column = 0; column < 4; column++)
      expect(flagsAt(packed, 4, 2, column) & FLAG_INVERSE).toBe(0);
  });

  it("paints only the visible part when the selection straddles the bottom edge", () => {
    const packed = emptyGrid(4, 3);
    // Selection from line 1 to line 5: only lines 1-2 are visible.
    applySelectionHighlight(packed, 4, { line: 1, column: 1 }, { line: 5, column: 2 });
    // Line 0: not part of the selection.
    for (let column = 0; column < 4; column++)
      expect(flagsAt(packed, 4, 0, column) & FLAG_INVERSE).toBe(0);
    // Line 1: columns 1-3 (from the start point to end of row).
    expect(flagsAt(packed, 4, 1, 0) & FLAG_INVERSE).toBe(0);
    expect(flagsAt(packed, 4, 1, 1) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    expect(flagsAt(packed, 4, 1, 3) & FLAG_INVERSE).toBe(FLAG_INVERSE);
    // Line 2: full width (interior line of the selection).
    for (let column = 0; column < 4; column++)
      expect(flagsAt(packed, 4, 2, column) & FLAG_INVERSE).toBe(FLAG_INVERSE);
  });
});
