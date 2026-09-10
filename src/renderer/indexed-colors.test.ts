import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EngineTerminal, engineMemory, loadEngine } from "../core/wasm";
import { buildPaletteBuffer, decodeColor } from "./palette";
import { buildInstanceData, FLOATS_PER_INSTANCE } from "./instance-data";

beforeAll(async () => {
  await loadEngine(readFileSync(join(import.meta.dirname, "..", "wasm", "celeritty_bg.wasm")));
});

describe("indexed colors from ANSI output", () => {
  it.each([
    { name: "foreground", sgr: 38, offset: 2 },
    { name: "background", sgr: 48, offset: 6 },
  ])("preserves every indexed $name through the GPU instance buffer", ({ sgr, offset }) => {
    const terminal = new EngineTerminal(16, 16);
    try {
      const sequence = Array.from({ length: 256 }, (_, index) => `\x1b[${sgr};5;${index}mX`).join(
        "",
      );
      terminal.feed(new TextEncoder().encode(sequence));
      terminal.refreshSnapshot();
      const packed = new Uint32Array(
        engineMemory(),
        terminal.snapshotPtr(),
        terminal.snapshotLen(),
      );
      const data = buildInstanceData(packed, 16, 16, {
        glyph: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }),
        isFull: false,
        reset: () => {},
      });
      for (let index = 0; index < 256; index++) {
        expect(packed[index * 4]).toBe(88);
        expect(data[index * FLOATS_PER_INSTANCE + offset]).toBe(index);
        expect(data[index * FLOATS_PER_INSTANCE + offset + 3]).toBe(1);
      }
    } finally {
      terminal.free();
    }
  });

  it.each([
    { name: "foreground", sgr: 38, word: 1 },
    { name: "background", sgr: 48, word: 2 },
  ])("resolves $name colors from the WASM snapshot", ({ sgr, word }) => {
    const terminal = new EngineTerminal(8, 1);
    const palette = buildPaletteBuffer(
      new Map([
        [256, "#dddddd"],
        [257, "#08090a"],
      ]),
    );
    try {
      // Indexed red, indexed gray, equivalent true color, then default reset.
      terminal.feed(
        new TextEncoder().encode(
          `\x1b[${sgr};5;196mR\x1b[${sgr};5;244mG\x1b[${sgr};2;255;0;0mT\x1b[0mD`,
        ),
      );
      terminal.refreshSnapshot();
      const packed = new Uint32Array(
        engineMemory(),
        terminal.snapshotPtr(),
        terminal.snapshotLen(),
      );
      const red = decodeColor(packed[word]);
      const gray = decodeColor(packed[4 + word]);
      expect(red).toEqual({ kind: "palette", index: 196 });
      expect(gray).toEqual({ kind: "palette", index: 244 });
      expect(String.fromCodePoint(packed[0], packed[4], packed[8], packed[12])).toBe("RGTD");
      expect(Array.from(palette.slice(196 * 4, 196 * 4 + 4))).toEqual([1, 0, 0, 1]);
      for (let channel = 0; channel < 3; channel++) {
        expect(palette[244 * 4 + channel]).toBeCloseTo(128 / 255, 6);
      }
      expect(decodeColor(packed[8 + word])).toEqual({ kind: "rgb", r: 255, g: 0, b: 0 });
      expect(decodeColor(packed[12 + word])).toEqual({ kind: "palette", index: 255 + word });
    } finally {
      terminal.free();
    }
  });
});
