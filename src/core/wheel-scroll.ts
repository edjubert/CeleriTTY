import type { MouseReportingState } from "./pointer";

/** Resolve the optional public multiplier before changing any terminal state. */
export function scrollSensitivity(value: number | undefined): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError("scrollSensitivity must be a finite, non-negative number.");
  }
  return value;
}

/** Fractional local scroll belongs to one terminal, never to a DOM binding. */
export class WheelScroll {
  #remainder = 0;
  #routing = -1;

  /** No engine reads are needed after output when there is no fraction to invalidate. */
  get pending(): boolean {
    return this.#remainder !== 0;
  }

  reset(): void {
    this.#remainder = 0;
  }

  /** Also called after parsing output, including synchronized-output flushes. */
  syncRouting(state: MouseReportingState): void {
    const routing =
      state.mouseReporting |
      (Number(state.sgrMouse) << 4) |
      (Number(state.altScreen) << 5) |
      (Number(state.alternateScroll) << 6) |
      (Number(state.applicationCursor) << 7);
    if (routing !== this.#routing) this.reset();
    this.#routing = routing;
  }

  lines(
    event: Pick<WheelEvent, "deltaMode" | "deltaY">,
    cellHeight: number,
    pageLines: number,
    sensitivity: number,
    offset: number,
    maxScroll: number,
  ): number {
    // Wheel deltas are CSS pixels, whereas atlas cells are physical pixels.
    const scale =
      event.deltaMode === 0
        ? 1 / cellHeight
        : event.deltaMode === 1
          ? 1
          : event.deltaMode === 2
            ? pageLines
            : 0;
    const delta = -event.deltaY * scale * sensitivity;
    if (Number.isNaN(delta) || delta === 0) return 0;
    // Reversing direction must not first repay a fraction from the old gesture.
    if (Math.sign(delta) !== Math.sign(this.#remainder)) this.reset();
    const available = delta > 0 ? maxScroll - offset : offset;
    if (available <= 0) {
      this.reset();
      return 0;
    }
    // Clamp before crossing the WASM i32 boundary (also handles overflow of
    // finite deltas/multipliers). Never bank overscroll at either boundary.
    const total = Math.min(Math.abs(delta + this.#remainder), available, 0x7fffffff);
    // Avoid losing a line to floating-point sums such as ten 0.1-line events.
    const whole = Math.floor(total + 1e-9);
    this.#remainder = total >= available ? 0 : Math.max(0, total - whole) * Math.sign(delta);
    return whole === 0 ? 0 : whole * Math.sign(delta);
  }
}
