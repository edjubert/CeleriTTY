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

  // Normalize order first (a drag can go in any direction), then intersect
  // with the visible viewport. Lines outside [0, lines-1] happen when the
  // selection was scrolled past an edge — those rows are simply not painted.
  let rawTopLine = Math.floor(start.line);
  let rawTopColumn = Math.floor(start.column);
  let rawBottomLine = Math.floor(end.line);
  let rawBottomColumn = Math.floor(end.column);
  if (
    rawTopLine > rawBottomLine ||
    (rawTopLine === rawBottomLine && rawTopColumn > rawBottomColumn)
  ) {
    const line = rawTopLine;
    const column = rawTopColumn;
    rawTopLine = rawBottomLine;
    rawTopColumn = rawBottomColumn;
    rawBottomLine = line;
    rawBottomColumn = column;
  }

  // Entirely outside the viewport: nothing to paint.
  if (rawBottomLine < 0 || rawTopLine > lines - 1) return;

  // Scalars only: defensive bounds must not allocate on the render path.
  // Clamp to the visible range, but remember whether each edge was clamped:
  // a clamped edge means the selection continues past the viewport, so the
  // first/last visible row is an interior row (full width), not an endpoint.
  const topLine = Math.max(0, rawTopLine);
  const topColumn = Math.max(0, Math.min(columns - 1, rawTopColumn));
  const bottomLine = Math.min(lines - 1, rawBottomLine);
  const bottomColumn = Math.max(0, Math.min(columns - 1, rawBottomColumn));
  const topIsEndpoint = rawTopLine >= 0;
  const bottomIsEndpoint = rawBottomLine <= lines - 1;

  for (let line = topLine; line <= bottomLine; line++) {
    const fromColumn = line === topLine && topIsEndpoint ? topColumn : 0;
    const toColumn = line === bottomLine && bottomIsEndpoint ? bottomColumn : columns - 1;
    for (let column = fromColumn; column <= toColumn; column++) {
      const flagsIndex = (line * columns + column) * WORDS_PER_CELL + 3;
      packed[flagsIndex] |= FLAG_INVERSE;
    }
  }
}
