// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRenderer } from "../renderer/fake-renderer";
import type { TerminalOptions } from "./types";
import { loadEngine } from "./wasm";
import { Terminal } from "./terminal";

// Exercise the real parser and public Terminal API without requiring a GPU.
vi.mock("../renderer/atlas", () => ({
  GlyphAtlas: class {
    readonly cell = { width: 8, height: 16 };
  },
}));

const options = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../fixtures/full-theme/expected.json"), "utf8"),
) as TerminalOptions;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
let terminal: Terminal;

beforeAll(async () => {
  await loadEngine(readFileSync(join(import.meta.dirname, "../wasm/celeritty_bg.wasm")));
});

beforeEach(async () => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const host = document.createElement("div");
  document.body.appendChild(host);
  terminal = new Terminal(host, options, async () => new FakeRenderer());
  await terminal.ready;
});

afterEach(() => {
  terminal?.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("terminal protocol replies", () => {
  it("routes queries injected through write without echoing ordinary text", () => {
    const output: string[] = [];
    terminal.on("data", (bytes) => output.push(decode(bytes)));
    terminal.write("text");
    expect(output).toEqual([]);
    terminal.write("\x1b[6n");
    expect(output).toEqual(["\x1b[1;5R"]);
  });

  it("emits a completed cursor report once and leaves ordinary text silent", () => {
    const output: string[] = [];
    terminal.on("data", (bytes) => output.push(decode(bytes)));
    terminal.feed(encode("hello\x1b[6"));
    expect(output).toEqual([]);
    terminal.feed(encode("n"));
    expect(output).toEqual(["\x1b[1;6R"]);
    terminal.feed(encode("world"));
    expect(output).toHaveLength(1);
  });

  it("forwards replies through the attached transport", () => {
    let receive: (bytes: Uint8Array) => void = () => {};
    const write = vi.fn();
    terminal.attach({
      write,
      resize: vi.fn(),
      onData: (cb) => {
        receive = cb;
        return () => {};
      },
      onClose: () => () => {},
    });
    receive(encode("\x1b[3;7H\x1b[6n\x1b[5n"));
    expect(write).toHaveBeenCalledExactlyOnceWith(encode("\x1b[3;7R\x1b[0n"));
  });

  it("drains before callbacks so reentrant feeds cannot duplicate replies", () => {
    const output: string[] = [];
    terminal.on("data", (bytes) => {
      output.push(decode(bytes));
      if (output.length === 1) terminal.feed(encode("\x1b[5n"));
    });
    terminal.feed(encode("\x1b[6n"));
    expect(output).toEqual(["\x1b[1;1R", "\x1b[0n"]);
  });

  it("does not replay replies generated before a listener subscribes", () => {
    terminal.feed(encode("\x1b[6n"));
    const output: string[] = [];
    terminal.on("data", (bytes) => output.push(decode(bytes)));
    terminal.feed(encode("text"));
    expect(output).toEqual([]);
    terminal.feed(encode("\x1b[5n"));
    expect(output).toEqual(["\x1b[0n"]);
  });

  it("allows a reply listener to dispose synchronously", () => {
    terminal.on("data", () => terminal.dispose());
    expect(() => terminal.feed(encode("\x1b[6n"))).not.toThrow();
    expect(() => terminal.feed(encode("\x1b[6n"))).toThrow(/after dispose/);
  });

  it("stops writing replies to a detached transport", () => {
    const write = vi.fn();
    terminal.attach({
      write,
      resize: vi.fn(),
      onData: () => () => {},
      onClose: () => () => {},
    });
    terminal.feed(encode("\x1b[5n"));
    expect(write).toHaveBeenCalledTimes(1);
    terminal.detach();
    terminal.feed(encode("\x1b[5n"));
    expect(write).toHaveBeenCalledTimes(1);
  });
});
