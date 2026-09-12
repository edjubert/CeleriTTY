import type { GridSize } from "../renderer/grid-metrics";
import type { CellPoint } from "./types";

/** Clamp viewport coordinates against the actual engine grid, not CSS bounds. */
export function clampCellPoint(point: CellPoint | null, grid: GridSize): CellPoint | null {
  if (
    point === null ||
    !Number.isFinite(point.line) ||
    !Number.isFinite(point.column) ||
    !Number.isFinite(grid.lines) ||
    !Number.isFinite(grid.columns) ||
    grid.lines < 1 ||
    grid.columns < 1
  )
    return null;
  return {
    line: Math.max(0, Math.min(Math.floor(point.line), grid.lines - 1)),
    column: Math.max(0, Math.min(Math.floor(point.column), grid.columns - 1)),
  };
}
