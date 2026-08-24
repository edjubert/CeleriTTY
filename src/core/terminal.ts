/**
 * A terminal bound to a host element.
 *
 * Owns the wasm engine, the glyph atlas, the renderer and the input
 * bindings. Knows nothing about the network: PTY output arrives through
 * `feed()`, and everything the user types leaves through the `data` event.
 * Plan 07 adds a transport on top of exactly those two.
 */

import { GlyphAtlas } from "../renderer/atlas";
import type { GridSize } from "../renderer/grid-metrics";
import { createWebGpuRenderer } from "../renderer/renderer";
import type { Renderer, RendererFactory } from "../renderer/renderer-interface";
import { bindInput } from "./input-bindings";
import {
  computeCellPoint,
  handleKeyDown,
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
  handleWheel,
  resolveLinkUrl,
  sendPointerToEngine,
} from "./input-handlers";
import type { InputHandlerState } from "./input-handlers";
import { computeGridResize, measureSurface } from "./metrics";
import { buildPaletteOverrides } from "./palette";
import {
  MOUSE_MOVE,
  MOUSE_PRESS,
  MOUSE_RELEASE,
  MOUSE_SCROLL_DOWN,
  MOUSE_SCROLL_UP,
  toEncoderButton,
} from "./pointer";
import { applySelectionHighlight } from "./selection-highlight";
import type { CellPoint, TerminalEvent, TerminalEventMap, TerminalOptions } from "./types";
import type { TerminalTransport } from "../transport/types";
import { EngineTerminal, encodeKey, engineMemory, loadEngine } from "./wasm";

type AnyListener = (payload: never) => void;

export class Terminal {
  readonly #host: HTMLElement;
  readonly #hostBounds = (): DOMRect => this.#host.getBoundingClientRect();
  readonly #canvas: HTMLCanvasElement;
  readonly #createRenderer: RendererFactory;
  readonly #listeners = new Map<TerminalEvent, Set<AnyListener>>();

  #options: TerminalOptions;
  #engine: InstanceType<typeof EngineTerminal> | undefined;
  #renderer: Renderer | undefined;
  #atlas: GlyphAtlas | undefined;
  #observer: ResizeObserver | undefined;
  #unbindInput: (() => void) | undefined;
  #frame = 0;
  #dirty = true;
  #grid: GridSize = { columns: 1, lines: 1 };
  #disposed = false;
  #transport: TerminalTransport | undefined;
  #transportOff: Array<() => void> = [];
  #selectionStart: CellPoint | null = null;
  #selectionEnd: CellPoint | null = null;
  #dragging = false;
  #hoveredLink: string | null = null;

  readonly ready: Promise<void>;

  constructor(
    host: HTMLElement,
    options: TerminalOptions,
    createRenderer: RendererFactory = createWebGpuRenderer,
  ) {
    this.#host = host;
    this.#options = options;
    this.#createRenderer = createRenderer;

    this.#canvas = host.ownerDocument.createElement("canvas");
    this.#canvas.style.display = "block";
    this.#canvas.style.width = "100%";
    this.#canvas.style.height = "100%";
    host.appendChild(this.#canvas);
    if (!host.hasAttribute("tabindex")) host.setAttribute("tabindex", "0");

    this.ready = this.#start();
  }

  // ---------------------------------------------------------------- lifecycle

  async #start(): Promise<void> {
    await loadEngine();
    this.#assertLive("start");

    const atlas = new GlyphAtlas(
      {
        family: this.#options.font.family,
        size: this.#options.font.size,
        weight: this.#options.font.weight ?? "400",
        lineHeight: this.#options.font.lineHeight ?? 1.2,
      },
      window.devicePixelRatio,
    );
    const renderer = await this.#createRenderer(this.#canvas, atlas);
    this.#assertLive("start");

    renderer.setPalette(buildPaletteOverrides(this.#options.colors));
    this.#atlas = atlas;
    this.#renderer = renderer;

    const engine = new EngineTerminal(80, 24);
    engine.setScrollbackLines(this.#options.scrollback);
    this.#engine = engine;
    this.#grid = { columns: 80, lines: 24 };
    this.#dirty = true;

    this.#observer = new ResizeObserver(() => this.#remeasure());
    this.#observer.observe(this.#host);
    this.#unbindInput = bindInput(this.#host, {
      onKeyDown: (event) => this.#handleKeyDown(event),
      onMouseDown: (event) => this.#handleMouseDown(event),
      onMouseUp: (event) => this.#handleMouseUp(event),
      onMouseMove: (event) => this.#handleMouseMove(event),
      onWheel: (event) => this.#handleWheel(event),
    });

    this.#remeasure();
    this.#frame = requestAnimationFrame(() => this.#draw());
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    cancelAnimationFrame(this.#frame);
    this.#observer?.disconnect();
    this.#unbindInput?.();
    this.#renderer?.dispose();
    this.#canvas.remove();
    this.#host.style.cursor = "";
    this.detach();
    this.#listeners.clear();
    this.#engine?.free();
    this.#engine = undefined;
  }

  // ------------------------------------------------------------------- events

  on<E extends TerminalEvent>(
    event: E,
    listener: (payload: TerminalEventMap[E]) => void,
  ): () => void {
    const set = this.#listeners.get(event) ?? new Set<AnyListener>();
    set.add(listener as AnyListener);
    this.#listeners.set(event, set);
    return () => {
      set.delete(listener as AnyListener);
    };
  }

  #emit<E extends TerminalEvent>(event: E, payload: TerminalEventMap[E]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (value: TerminalEventMap[E]) => void)(payload);
    }
  }

  // -------------------------------------------------------------- public API

  /** Feed PTY output in. */
  feed(bytes: Uint8Array): void {
    this.#requireEngine("feed").feed(bytes);
    this.#dirty = true;
  }

  /**
   * Connect to a process. Output is fed in, and everything the user types is
   * written out — so a host that attaches a transport no longer needs to
   * listen for `data` itself.
   *
   * Attaching over an existing transport detaches the old one first, rather
   * than quietly ending up with two sockets writing to the same grid.
   */
  attach(transport: TerminalTransport): void {
    this.#assertLive("attach");
    this.detach();

    this.#transport = transport;
    this.#transportOff = [
      transport.onData((bytes) => this.feed(bytes)),
      transport.onClose((reason) => {
        this.detach();
        if (reason !== undefined) {
          this.#emit("error", new Error(reason));
        }
      }),
      this.on("data", (bytes) => transport.write(bytes)),
      this.on("resize", (grid) => transport.resize(grid.columns, grid.lines)),
    ];

    // The grid is already measured by the time a host attaches, and the
    // process was spawned at whatever size the host guessed. Send the real
    // one immediately, or a full-screen program draws for the wrong grid
    // until the next resize — which may never come.
    transport.resize(this.#grid.columns, this.#grid.lines);
  }

  /** The currently attached transport, if any. */
  get transport(): TerminalTransport | undefined {
    return this.#transport;
  }

  /** Disconnect. Safe to call when nothing is attached. */
  detach(): void {
    for (const off of this.#transportOff) off();
    this.#transportOff = [];
    this.#transport = undefined;
  }

  /** Inject text as if the program had printed it. Does not reach the PTY. */
  write(text: string): void {
    this.feed(new TextEncoder().encode(text));
  }

  setOptions(patch: Partial<TerminalOptions>): void {
    const previous = this.#options;
    this.#options = { ...previous, ...patch };

    if (patch.colors !== undefined) {
      this.#renderer?.setPalette(buildPaletteOverrides(this.#options.colors));
      this.#dirty = true;
    }
    if (patch.scrollback !== undefined) {
      this.#engine?.setScrollbackLines(this.#options.scrollback);
    }
    if (patch.font !== undefined) {
      this.#rebuildAtlas();
    }
  }

  focus(): void {
    this.#host.focus();
  }

  blur(): void {
    this.#host.blur();
  }

  clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }

  scrollLines(delta: number): void {
    this.#requireEngine("scrollLines").scrollLines(delta);
    this.#dirty = true;
  }

  scrollToBottom(): void {
    this.#requireEngine("scrollToBottom").resetScroll();
    this.#dirty = true;
  }

  getSelection(): string | null {
    const start = this.#selectionStart;
    const end = this.#selectionEnd;
    if (start === null || end === null) return null;

    const engine = this.#requireEngine("getSelection");
    const offset = engine.displayOffset;
    const [top, bottom] =
      start.line < end.line || (start.line === end.line && start.column <= end.column)
        ? [start, end]
        : [end, start];

    const text = engine.selectedText(
      top.line - offset,
      top.column,
      bottom.line - offset,
      bottom.column,
    );
    return text === "" ? null : text;
  }

  async copySelection(): Promise<void> {
    const text = this.getSelection();
    if (text === null) return;
    await navigator.clipboard.writeText(text);
  }

  // --------------------------------------------------------------- internals

  #draw(): void {
    const engine = this.#engine;
    const renderer = this.#renderer;
    if (engine !== undefined && renderer !== undefined && this.#dirty) {
      try {
        engine.refreshSnapshot();
        const packed = new Uint32Array(engineMemory(), engine.snapshotPtr(), engine.snapshotLen());
        applySelectionHighlight(packed, engine.columns, this.#selectionStart, this.#selectionEnd);
        renderer.render({ columns: engine.columns, lines: engine.screenLines, packed });
        this.#dirty = false;
      } catch (error) {
        // A thrown frame must not silently kill the render loop forever —
        // without this, the terminal goes blank with nothing further in the
        // console, which is much harder to diagnose than a loud repeated
        // error. This does not make the frame's content correct; it only
        // keeps the loop (and any future recovery) alive.
        this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.#frame = requestAnimationFrame(() => this.#draw());
  }

  #remeasure(): void {
    const atlas = this.#atlas;
    const engine = this.#engine;
    if (atlas === undefined || engine === undefined) return;

    const bounds = this.#hostBounds();
    const measured = measureSurface(bounds, atlas.cell, window.devicePixelRatio);
    if (measured === null) return;

    this.#canvas.width = measured.pixels.width;
    this.#canvas.height = measured.pixels.height;

    const changed = computeGridResize(this.#grid, measured.grid);
    if (changed === null) {
      this.#dirty = true;
      return;
    }
    engine.resize(changed.columns, changed.lines);
    this.#grid = changed;
    this.#dirty = true;
    this.#emit("resize", changed);
  }

  #rebuildAtlas(): void {
    const renderer = this.#renderer;
    if (renderer === undefined) return;

    const atlas = new GlyphAtlas(
      {
        family: this.#options.font.family,
        size: this.#options.font.size,
        weight: this.#options.font.weight ?? "400",
        lineHeight: this.#options.font.lineHeight ?? 1.2,
      },
      window.devicePixelRatio,
    );
    this.#atlas = atlas;
    renderer.setAtlas(atlas);
    this.#remeasure();
  }

  #handleKeyDown(event: KeyboardEvent): void {
    if (this.#engine === undefined) return;
    handleKeyDown(this.#buildState(), event, encodeKey);
  }

  #buildState(): InputHandlerState {
    const engine = this.#engine;
    const atlas = this.#atlas;
    const dpr = window.devicePixelRatio;

    return {
      engine,
      emit: (event, payload) => this.#emit(event as TerminalEvent, payload as never),
      clearSelection: () => this.#clearSelection(),
      cellAt: (event) => (atlas ? computeCellPoint(atlas, this.#hostBounds, event) : null),
      sendPointer: (kind, button, event) =>
        engine !== undefined && atlas !== undefined
          ? sendPointerToEngine(
              engine,
              atlas,
              this.#hostBounds,
              dpr,
              kind,
              button,
              event,
              (bytes) => this.#emit("data", bytes),
            )
          : false,
      dragging: this.#dragging,
      setDragging: (v) => {
        this.#dragging = v;
      },
      selectionStart: this.#selectionStart,
      setSelectionStart: (v) => {
        this.#selectionStart = v;
      },
      selectionEnd: this.#selectionEnd,
      setSelectionEnd: (v) => {
        this.#selectionEnd = v;
      },
      dirty: this.#dirty,
      setDirty: (v) => {
        this.#dirty = v;
      },
      host: this.#host,
      linkAt: (event) => {
        if (engine === undefined || atlas === undefined) return null;
        const cell = computeCellPoint(atlas, this.#hostBounds, event);
        if (cell === null) return null;
        return resolveLinkUrl(engine, cell);
      },
    };
  }

  #handleMouseDown(event: MouseEvent): void {
    handleMouseDown(this.#buildState(), event, toEncoderButton, MOUSE_PRESS);
  }

  #handleMouseMove(event: MouseEvent): void {
    const state = this.#buildState();
    handleMouseMove(
      state,
      event,
      MOUSE_MOVE,
      // Only called by handleMouseMove when the hovered URL actually
      // changed since the previous move event — no extra gating needed here.
      (url) => {
        this.#host.style.cursor = url === null ? "" : "pointer";
        this.#emit("link-hover", url);
      },
      (event) => {
        const engine = this.#engine;
        const atlas = this.#atlas;
        if (engine === undefined || atlas === undefined) return null;
        const cell = computeCellPoint(atlas, this.#hostBounds, event);
        if (cell === null) return null;
        return resolveLinkUrl(engine, cell);
      },
      { current: this.#hoveredLink },
    );
    const atlas = this.#atlas;
    const cell = atlas ? computeCellPoint(atlas, this.#hostBounds, event) : null;
    const url = cell ? resolveLinkUrl(this.#engine!, cell) : null;
    this.#hoveredLink = url;
  }

  #handleMouseUp(event: MouseEvent): void {
    handleMouseUp(this.#buildState(), event, toEncoderButton, MOUSE_RELEASE, () =>
      this.getSelection(),
    );
  }

  #handleWheel(event: WheelEvent): void {
    const state = this.#buildState();
    handleWheel(state, event, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, (delta) =>
      this.scrollLines(delta),
    );
  }

  #clearSelection(): void {
    if (this.#selectionStart === null && this.#selectionEnd === null) return;
    this.#selectionStart = null;
    this.#selectionEnd = null;
    this.#emit("selection-change", null);
  }

  #requireEngine(method: string): InstanceType<typeof EngineTerminal> {
    this.#assertLive(method);
    const engine = this.#engine;
    if (engine === undefined) {
      throw new Error(`Terminal.${method}() was called before \`ready\` resolved.`);
    }
    return engine;
  }

  #assertLive(method: string): void {
    if (this.#disposed) {
      throw new Error(`Terminal.${method}() was called after dispose().`);
    }
  }
}
