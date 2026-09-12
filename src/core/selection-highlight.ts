import { WORDS_PER_CELL } from "../renderer/instance-data";
import type { CellPoint } from "./types";

/**
 * Bit 0 of the flags word — matches alacritty's `Flags::INVERSE`, the same
 * bit the Rust side already sets for the cursor cell. Reusing it means the
 * selection needs no new shader path and no new palette slot.
 */
const FLAG_INVERSE = 1;

/**
 * OR the `INVERSE` flag into every cell between `start` and `end`
 * (inclusive), normalizing their order first — a mouse drag can go in any of
 * four directions. No-ops when either point is `null` (no active selection).
 *
 * Mutates `packed` in place: this runs once per animation frame against the
 * engine's live snapshot view, so it must not allocate.
 */
export function applySelectionHighlight(
  packed: Uint32Array,
  columns: number,
  start: CellPoint | null,
  end: CellPoint | null,
): void {
  if (start === null || end === null) return;
  const lines = Math.floor(packed.length / WORDS_PER_CELL / columns);
  if (
    !Number.isFinite(columns) ||
    columns < 1 ||
    !Number.isFinite(lines) ||
    lines < 1 ||
    !Number.isFinite(start.line) ||
    !Number.isFinite(start.column) ||
    !Number.isFinite(end.line) ||
    !Number.isFinite(end.column)
  )
    return;

  // Scalars only: defensive bounds must not allocate on the render path.
  let topLine = Math.max(0, Math.min(lines - 1, Math.floor(start.line)));
  let topColumn = Math.max(0, Math.min(columns - 1, Math.floor(start.column)));
  let bottomLine = Math.max(0, Math.min(lines - 1, Math.floor(end.line)));
  let bottomColumn = Math.max(0, Math.min(columns - 1, Math.floor(end.column)));
  if (topLine > bottomLine || (topLine === bottomLine && topColumn > bottomColumn)) {
    const line = topLine;
    const column = topColumn;
    topLine = bottomLine;
    topColumn = bottomColumn;
    bottomLine = line;
    bottomColumn = column;
  }

  for (let line = topLine; line <= bottomLine; line++) {
    const fromColumn = line === topLine ? topColumn : 0;
    const toColumn = line === bottomLine ? bottomColumn : columns - 1;
    for (let column = fromColumn; column <= toColumn; column++) {
      const flagsIndex = (line * columns + column) * WORDS_PER_CELL + 3;
      packed[flagsIndex] |= FLAG_INVERSE;
    }
  }
}
