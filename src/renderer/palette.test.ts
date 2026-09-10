import { describe, expect, it } from "vitest";
import { PALETTE_ENTRIES, buildPaletteBuffer, decodeColor } from "./palette";

describe("decodeColor", () => {
  it("recognizes a palette index", () => {
    const decoded = decodeColor((1 << 24) | 5);
    expect(decoded).toEqual({ kind: "palette", index: 5 });
  });

  it("recognizes the named slots above the 8-bit palette", () => {
    const decoded = decodeColor((1 << 24) | 256);
    expect(decoded).toEqual({ kind: "palette", index: 256 });
  });

  it("recognizes a true-color value", () => {
    const decoded = decodeColor((2 << 24) | 0x123456);
    expect(decoded).toEqual({ kind: "rgb", r: 0x12, g: 0x34, b: 0x56 });
  });
});

describe("buildPaletteBuffer", () => {
  it("produces four floats per palette entry", () => {
    const buffer = buildPaletteBuffer(new Map());
    expect(buffer.length).toBe(PALETTE_ENTRIES * 4);
  });

  it("writes overrides as normalized rgba", () => {
    const buffer = buildPaletteBuffer(new Map([[1, "#ff8000"]]));
    expect(buffer[4]).toBeCloseTo(1);
    expect(buffer[5]).toBeCloseTo(0x80 / 255);
    expect(buffer[6]).toBeCloseTo(0);
    expect(buffer[7]).toBeCloseTo(1);
  });

  it("initializes all 216 entries of the indexed color cube", () => {
    const buffer = buildPaletteBuffer(new Map());
    const levels = [0, 95, 135, 175, 215, 255];
    let index = 16;
    for (const red of levels) {
      for (const green of levels) {
        for (const blue of levels) {
          expectColor(buffer, index++, [red, green, blue]);
        }
      }
    }
    expect(index).toBe(232);
  });

  it("initializes all 24 grayscale entries", () => {
    const buffer = buildPaletteBuffer(new Map());
    for (let step = 0; step < 24; step++) {
      const gray = 8 + step * 10;
      expectColor(buffer, 232 + step, [gray, gray, gray]);
    }
  });

  it("keeps extended colors independent of the theme's ANSI and default colors", () => {
    const buffer = buildPaletteBuffer(
      new Map([
        [1, "#123456"],
        [256, "#dddddd"],
        [257, "#08090a"],
        [258, "#abcdef"],
      ]),
    );
    expectColor(buffer, 1, [0x12, 0x34, 0x56]);
    expectColor(buffer, 256, [221, 221, 221]);
    expectColor(buffer, 257, [8, 9, 10]);
    expectColor(buffer, 258, [0xab, 0xcd, 0xef]);
    expectColor(buffer, 196, [255, 0, 0]);
    expectColor(buffer, 244, [128, 128, 128]);
  });

  it("allows explicit extended-color overrides and restores defaults on rebuild", () => {
    const custom = buildPaletteBuffer(
      new Map([
        [196, "#123456"],
        [244, "#abcdef"],
      ]),
    );
    expectColor(custom, 196, [0x12, 0x34, 0x56]);
    expectColor(custom, 244, [0xab, 0xcd, 0xef]);
    const defaults = buildPaletteBuffer(new Map());
    expectColor(defaults, 196, [255, 0, 0]);
    expectColor(defaults, 244, [128, 128, 128]);
    expectColor(custom, 196, [0x12, 0x34, 0x56]);
  });

  it("keeps unspecified ANSI and named slots opaque black", () => {
    const buffer = buildPaletteBuffer(new Map());
    for (let index = 0; index < PALETTE_ENTRIES; index++) {
      if (index < 16 || index >= 256) expectColor(buffer, index, [0, 0, 0]);
    }
  });

  it("does not add defaults to or change the caller's override map", () => {
    const overrides = new Map([[244, "#123456"]]);
    buildPaletteBuffer(overrides);
    expect([...overrides]).toEqual([[244, "#123456"]]);
  });

  it.each([-1, PALETTE_ENTRIES])("rejects out-of-range override slot %i", (index) => {
    expect(() => buildPaletteBuffer(new Map([[index, "#123456"]]))).toThrow(/outside/);
  });

  it("rejects a malformed color rather than drawing something wrong", () => {
    expect(() => buildPaletteBuffer(new Map([[0, "not-a-color"]]))).toThrow(/not-a-color/);
  });
});

function expectColor(buffer: Float32Array, index: number, rgb: [number, number, number]): void {
  rgb.forEach((channel, offset) =>
    expect(buffer[index * 4 + offset]).toBeCloseTo(channel / 255, 6),
  );
  expect(buffer[index * 4 + 3]).toBe(1);
}
