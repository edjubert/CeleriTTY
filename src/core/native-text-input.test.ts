// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRenderer } from "../renderer/fake-renderer";
import { Terminal } from "./terminal";
import type { TerminalOptions } from "./types";
import { loadEngine } from "./wasm";

const OPTIONS: TerminalOptions = {
  font: { family: "monospace", size: 13 },
  colors: {
    black: "#000000",
    red: "#cd0000",
    green: "#00cd00",
    yellow: "#cdcd00",
    blue: "#0000ee",
    magenta: "#cd00cd",
    cyan: "#00cdcd",
    white: "#e5e5e5",
    brightBlack: "#7f7f7f",
    brightRed: "#ff0000",
    brightGreen: "#00ff00",
    brightYellow: "#ffff00",
    brightBlue: "#5c5cff",
    brightMagenta: "#ff00ff",
    brightCyan: "#00ffff",
    brightWhite: "#ffffff",
    foreground: "#e5e5e5",
    background: "#000000",
    cursor: "#e5e5e5",
  },
  cursor: { style: "block", blink: false },
  scrollback: 1_000,
};

const terminals: Terminal[] = [];

beforeAll(async () => {
  await loadEngine(readFileSync(join(import.meta.dirname, "..", "wasm", "celeritty_bg.wasm")));
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          beginPath: vi.fn(),
          clip: vi.fn(),
          fillText: vi.fn(),
          measureText: () => ({ width: 8 }),
          rect: vi.fn(),
          restore: vi.fn(),
          save: vi.fn(),
        };
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const terminal = new Terminal(host, OPTIONS, createFakeRenderer);
  terminals.push(terminal);
  await terminal.ready;
  const input = host.querySelector<HTMLTextAreaElement>("textarea[data-celeritty-input]");
  return { host, input, terminal };
}

function textFrom(events: Uint8Array[]): string[] {
  const decoder = new TextDecoder();
  return events.map((bytes) => decoder.decode(bytes));
}

describe("Terminal native text input", () => {
  it("focuses its native input without creating a second tab stop", async () => {
    const { host, input, terminal } = await mount();

    expect(input).not.toBeNull();
    expect(input?.tabIndex).toBe(-1);
    terminal.focus();
    expect(document.activeElement).toBe(input);

    host.focus();
    expect(document.activeElement).toBe(input);
  });

  it("sends a physical key once even if an overlapping input event arrives", async () => {
    const { input, terminal } = await mount();
    const data: Uint8Array[] = [];
    terminal.on("data", (bytes) => data.push(bytes));

    const key = new KeyboardEvent("keydown", {
      key: "é",
      bubbles: true,
      cancelable: true,
    });
    input?.dispatchEvent(key);
    input?.dispatchEvent(
      new InputEvent("input", { data: "é", inputType: "insertText", bubbles: true }),
    );

    expect(key.defaultPrevented).toBe(true);
    expect(textFrom(data)).toEqual(["é"]);
  });

  it("accepts virtual keyboard edits and committed IME text without duplicates", async () => {
    const { host, input, terminal } = await mount();
    const data: Uint8Array[] = [];
    const leakedCompositionKey = vi.fn();
    terminal.on("data", (bytes) => data.push(bytes));
    host.addEventListener("keydown", leakedCompositionKey, true);

    input?.dispatchEvent(new InputEvent("input", { data: "hello 世界", inputType: "insertText" }));
    input?.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward" }));
    input?.dispatchEvent(new InputEvent("input", { inputType: "insertLineBreak" }));
    input?.dispatchEvent(new CompositionEvent("compositionstart"));
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Process", isComposing: true, bubbles: true }),
    );
    input?.dispatchEvent(new InputEvent("input", { data: "あ", isComposing: true }));
    const compositionEnd = new CompositionEvent("compositionend");
    Object.defineProperty(compositionEnd, "data", { value: "あ" });
    input?.dispatchEvent(compositionEnd);
    input?.dispatchEvent(
      new InputEvent("input", { data: "あ", inputType: "insertFromComposition" }),
    );

    expect(textFrom(data)).toEqual(["hello 世界", "\x7f", "\r", "あ"]);
    expect(leakedCompositionKey).not.toHaveBeenCalled();
  });

  it("wraps paste only while the application enables bracketed paste", async () => {
    const { input, terminal } = await mount();
    const data: Uint8Array[] = [];
    terminal.on("data", (bytes) => data.push(bytes));
    const paste = (text: string): void => {
      const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", {
        value: { getData: () => text },
      });
      input?.dispatchEvent(event);
    };

    paste("first\nsecond");
    terminal.feed(new TextEncoder().encode("\x1b[?2004h"));
    paste("third\nfourth");

    expect(textFrom(data)).toEqual(["first\rsecond", "\x1b[200~third\rfourth\x1b[201~"]);
  });

  it("does not steal focus when another instance mounts or a hidden tab reopens", async () => {
    const first = await mount();
    first.terminal.focus();
    expect(document.activeElement).toBe(first.input);

    const second = await mount();
    expect(document.activeElement).toBe(first.input);
    first.host.hidden = true;
    second.terminal.focus();
    first.host.hidden = false;

    expect(document.activeElement).toBe(second.input);
  });
});
