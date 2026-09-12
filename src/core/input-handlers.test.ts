import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeCellPoint } from "./input-handlers";

describe("computeCellPoint", () => {
  const atlas = { cell: { width: 10, height: 20 } };
  const dpr = 2;

  beforeAll(() => {
    vi.stubGlobal("window", { devicePixelRatio: dpr });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("computes a cell from the given hostBounds, ignoring event.currentTarget", () => {
    const hostBounds = () => ({ left: 100, top: 50 }) as DOMRect;
    const event = { clientX: 130, clientY: 90, currentTarget: null } as unknown as MouseEvent;

    const cell = computeCellPoint(atlas, hostBounds, event, { columns: 80, lines: 24 });

    expect(cell).not.toBeNull();
    expect(cell?.column).toBe(Math.floor(((130 - 100) * dpr) / 10));
    expect(cell?.line).toBe(Math.floor(((90 - 50) * dpr) / 20));
  });

  it("clamps negative coordinates to 0", () => {
    const hostBounds = () => ({ left: 500, top: 500 }) as DOMRect;
    const event = { clientX: 0, clientY: 0, currentTarget: null } as unknown as MouseEvent;

    const cell = computeCellPoint(atlas, hostBounds, event, { columns: 80, lines: 24 });

    expect(cell).toEqual({ column: 0, line: 0 });
  });
});

describe("selection coordinates at fractional and stale surface boundaries", () => {
  afterAll(() => vi.unstubAllGlobals());
  for (const dpr of [1, 1.25, 2]) {
    it(`clamps all edges against the engine grid at DPR ${dpr}`, () => {
      vi.stubGlobal("window", { devicePixelRatio: dpr });
      const atlas = { cell: { width: 10, height: 20 } };
      const bounds = () => ({ left: 10, top: 20, width: 333.4, height: 201.4 }) as DOMRect;
      // Deliberately differs from the CSS measurement: ResizeObserver has not run yet.
      const grid = { columns: 12, lines: 4 };
      for (const x of [-100, 0, 9.99, 10, 343.3, 343.4, 100000]) {
        for (const y of [-100, 0, 19.99, 20, 221.3, 221.4, 100000]) {
          const event = { clientX: x, clientY: y } as MouseEvent;
          expect(computeCellPoint(atlas, bounds, event, grid)).toEqual({
            column: Math.max(0, Math.min(11, Math.floor(((x - 10) * dpr) / 10))),
            line: Math.max(0, Math.min(3, Math.floor(((y - 20) * dpr) / 20))),
          });
        }
      }
      expect(
        computeCellPoint(atlas, bounds, { clientX: NaN, clientY: 20 } as MouseEvent, grid),
      ).toBeNull();
      expect(
        computeCellPoint(atlas, bounds, { clientX: Infinity, clientY: 20 } as MouseEvent, grid),
      ).toBeNull();
      expect(
        computeCellPoint(atlas, bounds, { clientX: 1000, clientY: 20 } as MouseEvent, grid, false),
      ).toBeNull();
      expect(
        computeCellPoint(atlas, bounds, { clientX: 9, clientY: 20 } as MouseEvent, grid, false),
      ).toBeNull();
    });
  }
});
