import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EngineTerminal, engineMemory, loadEngine } from "./wasm";
import {
  handleKeyDown,
  handleWheel,
  resolveLinkUrl,
  type InputHandlerState,
} from "./input-handlers";

beforeAll(async () => {
  await loadEngine(readFileSync(new URL("../wasm/celeritty_bg.wasm", import.meta.url)));
});

let engine: InstanceType<typeof EngineTerminal>;
afterEach(() => engine?.free());

function setup(): InputHandlerState {
  engine = new EngineTerminal(32, 3);
  engine.feed(new TextEncoder().encode("https://example.com\r\ntwo\r\nthree\r\nfour\r\nfive"));
  return {
    engine,
    sendPointer: vi.fn(() => false),
    clearSelection: vi.fn(),
    setDirty: vi.fn(),
    emit: vi.fn(),
  } as unknown as InputHandlerState;
}

function firstRenderedRow(): string {
  engine.refreshSnapshot();
  const packed = new Uint32Array(engineMemory(), engine.snapshotPtr(), engine.snapshotLen());
  return Array.from({ length: engine.columns }, (_, i) => String.fromCodePoint(packed[i * 4]))
    .join("")
    .trimEnd();
}

describe("scrollback through the WASM/input boundary", () => {
  it("wheel scrolling changes the rendered viewport and resolves history links", () => {
    const state = setup();
    const event = { deltaY: -100, preventDefault: vi.fn() } as unknown as WheelEvent;
    handleWheel(state, event, 4, 5, (delta) => engine.scrollLines(delta));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(firstRenderedRow()).toBe("https://example.com");
    expect(resolveLinkUrl(engine, { line: 0, column: 5 })).toBe("https://example.com");
    expect(resolveLinkUrl(engine, { line: 1, column: 5 })).toBeNull();
    handleWheel(state, { ...event, deltaY: 100 } as WheelEvent, 4, 5, (delta) =>
      engine.scrollLines(delta),
    );
    expect(firstRenderedRow()).toBe("three");
    expect(resolveLinkUrl(engine, { line: 0, column: 5 })).toBeNull();
  });

  it("keeps application-handled wheel events out of local scrollback", () => {
    const state = setup();
    state.sendPointer = vi.fn(() => true);
    const scroll = vi.fn();
    handleWheel(state, { deltaY: -1 } as WheelEvent, 4, 5, scroll);
    expect(scroll).not.toHaveBeenCalled();
    expect(engine.displayOffset).toBe(0);
  });

  it("preserves history on output, but typing explicitly returns to the live screen", () => {
    const state = setup();
    engine.scrollLines(2);
    engine.feed(new TextEncoder().encode("\r\nsix"));
    expect(firstRenderedRow()).toBe("https://example.com");
    expect(engine.selectedText(0, 0, 0, 18)).toBe("https://example.com");
    const bytes = new Uint8Array([120]);
    handleKeyDown(
      state,
      { key: "x", preventDefault: vi.fn() } as unknown as KeyboardEvent,
      () => bytes,
    );
    expect(firstRenderedRow()).toBe("four");
    expect(state.clearSelection).toHaveBeenCalled();
    expect(state.setDirty).toHaveBeenCalledWith(true);
    expect(state.emit).toHaveBeenCalledWith("data", bytes);
  });
});
