/**
 * A terminal bound to a host element.
 *
 * Owns the wasm engine, the glyph atlas, the renderer and the input
 * bindings. Knows nothing about the network: PTY output arrives through
 * `feed()`, and everything the user types leaves through the `data` event.
 * Plan 07 adds a transport on top of exactly those two.
 */

import { safely } from "../shared/disposal";
import { GlyphAtlas } from "../renderer/atlas";
import type { GridSize } from "../renderer/grid-metrics";
import { createWebGpuRenderer } from "../renderer/renderer";
import type { Renderer, RendererFactory } from "../renderer/renderer-interface";
import { bindInput } from "./input-bindings";
import {
  computeCellPoint,
  dragAutoScrollLines,
  handleKeyDown,
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
  handleWheel,
  resolveLinkUrl,
  SELECTION_SIMPLE,
  selectionPointAt,
  sendPointerToEngine,
  shiftCellPoint,
} from "./input-handlers";
import type { InputHandlerState, SelectionKind, SelectionPoint } from "./input-handlers";
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
import { clampCellPoint } from "./selection-bounds";
import { applySelectionHighlight } from "./selection-highlight";
import { createNativeTextInput, isCompositionKey } from "./text-input";
import type { NativeTextInput } from "./text-input";
import type { CellPoint, TerminalEvent, TerminalEventMap, TerminalOptions } from "./types";
import type { TerminalTransport, TerminalOutputOptions } from "../transport/types";
import { EngineTerminal, encodeKey, engineMemory, loadEngine } from "./wasm";
import { scrollSensitivity, WheelScroll } from "./wheel-scroll";

type AnyListener = (payload: never) => void;

/**
 * How long a link click waits for a second click before opening. Browsers do
 * not expose the system double-click interval; 500 ms is the common default.
 * Without the wait, the first click of a double click on a URL would open it.
 */
const LINK_ACTIVATION_DELAY_MS = 500;

export class Terminal {
  readonly #host: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #surfaceBounds = (): DOMRect => this.#canvas.getBoundingClientRect();
  readonly #createRenderer: RendererFactory;
  readonly #listeners = new Map<TerminalEvent, Set<AnyListener>>();
  readonly #addedTabIndex: boolean;

  #options: TerminalOptions;
  readonly #wheel = new WheelScroll();
  #wheelCellHeight = 1;
  #engine: InstanceType<typeof EngineTerminal> | undefined;
  #renderer: Renderer | undefined;
  #atlas: GlyphAtlas | undefined;
  #observer: ResizeObserver | undefined;
  #unbindInput: (() => void) | undefined;
  #unbindRendererDiagnostic: (() => void) | undefined;
  #unbindRendererError: (() => void) | undefined;
  #textInput: NativeTextInput | undefined;
  #frame = 0;
  #dirty = true;
  #replyToQueries = true;
  #syncPending = false;
  #grid: GridSize = { columns: 1, lines: 1 };
  #disposed = false;
  #transport: TerminalTransport | undefined;
  #transportOff: Array<() => void> = [];
  #transportGeneration = 0;
  // The highlighted cells, inclusive and in reading order, resolved by the
  // engine from where the pointer pressed (anchor) and where it is (focus).
  #selectionStart: CellPoint | null = null;
  #selectionEnd: CellPoint | null = null;
  #selectionAnchor: SelectionPoint | null = null;
  #selectionFocus: SelectionPoint | null = null;
  #selectionKind: SelectionKind = SELECTION_SIMPLE;
  #dragging = false;
  #dragScrollDelta = 0;
  #dragScrollTimer: ReturnType<typeof setInterval> | undefined;
  #hoveredLink: string | null = null;
  #linkTimer: ReturnType<typeof setTimeout> | undefined;

  readonly ready: Promise<void>;

  constructor(
    host: HTMLElement,
    options: TerminalOptions,
    createRenderer: RendererFactory = createWebGpuRenderer,
  ) {
    this.#host = host;
    this.#options = { ...options, scrollSensitivity: scrollSensitivity(options.scrollSensitivity) };
    this.#createRenderer = createRenderer;

    this.#canvas = host.ownerDocument.createElement("canvas");
    this.#canvas.style.display = "block";
    this.#canvas.style.width = "100%";
    this.#canvas.style.height = "100%";
    host.appendChild(this.#canvas);
    this.#addedTabIndex = !host.hasAttribute("tabindex");
    if (this.#addedTabIndex) host.setAttribute("tabindex", "0");

    this.ready = this.#start().catch((error: unknown) => {
      // A failed startup must leave the host ready for a compatibility
      // renderer, even when the caller only observes `ready` and never calls
      // `dispose()` itself.
      this.dispose();
      throw error;
    });
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
    let renderer: Renderer | undefined;
    try {
      renderer = await this.#createRenderer(this.#canvas, atlas);
      this.#assertLive("start");

      renderer.setPalette(buildPaletteOverrides(this.#options.colors));
      this.#atlas = atlas;
      this.#renderer = renderer;
      renderer = undefined;
    } finally {
      // Cancellation can happen while the asynchronous renderer factory is
      // acquiring a GPU device. If it completes afterwards, the renderer was
      // never transferred to the terminal and must be released here.
      safely(renderer?.dispose.bind(renderer));
    }

    let starting = true;
    let startupRendererError: Error | undefined;
    this.#unbindRendererError = this.#renderer.onError?.((error) => {
      if (this.#disposed) return;
      if (starting) {
        startupRendererError = error;
        return;
      }
      this.#handleRendererError(error);
    });
    if (startupRendererError !== undefined) {
      this.dispose();
      throw startupRendererError;
    }
    this.#unbindRendererDiagnostic = this.#renderer.onDiagnostic?.((error) => {
      if (!this.#disposed) this.#emit("diagnostic", error);
    });

    this.#assertLive("start");
    const engine = new EngineTerminal(80, 24);
    engine.setScrollbackLines(this.#options.scrollback);
    // OSC 10/11/12 queries must be answerable from the first byte the PTY
    // sends: Vibe asks for the background color before it renders anything.
    engine.setNamedColors(
      this.#options.colors.foreground,
      this.#options.colors.background,
      this.#options.colors.cursor,
    );
    this.#engine = engine;
    starting = false;
    this.#grid = { columns: 80, lines: 24 };
    this.#dirty = true;

    this.#observer = new ResizeObserver(() => this.#remeasure());
    this.#observer.observe(this.#canvas, { box: "content-box" });
    this.#textInput = createNativeTextInput(this.#host, {
      onText: (text) => this.#sendText(text, false),
      onPaste: (text) => this.#sendText(text, true),
    });
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
    this.#stopDragScroll();
    this.#cancelLinkActivation();
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    safely(this.#observer?.disconnect.bind(this.#observer));
    this.#observer = undefined;
    safely(this.#unbindInput);
    this.#unbindInput = undefined;
    safely(this.#unbindRendererError);
    this.#unbindRendererError = undefined;
    safely(this.#unbindRendererDiagnostic);
    this.#unbindRendererDiagnostic = undefined;
    safely(this.#textInput?.dispose.bind(this.#textInput));
    this.#textInput = undefined;
    safely(this.#renderer?.dispose.bind(this.#renderer));
    this.#renderer = undefined;
    this.#atlas = undefined;
    this.#canvas.remove();
    this.#host.style.cursor = "";
    this.detach();
    this.#listeners.clear();
    safely(this.#engine?.free.bind(this.#engine));
    this.#engine = undefined;
    if (this.#addedTabIndex && this.#host.getAttribute("tabindex") === "0") {
      this.#host.removeAttribute("tabindex");
    }
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

  /** Feed live PTY output. Disable replies explicitly for replayed history. */
  feed(bytes: Uint8Array, options: TerminalOutputOptions = {}): void {
    this.#assertLive("feed");
    const replyToQueries = options.replyToQueries !== false;
    // VTE may still hold queries from previous chunks. Complete that batch
    // under its original policy before switching between replay and live data.
    const deferred = replyToQueries !== this.#replyToQueries ? this.#flushSync(true) : undefined;
    this.#replyToQueries = replyToQueries;
    const engine = this.#requireEngine("feed");
    engine.feed(bytes);
    if (this.#wheel.pending) this.#wheel.syncRouting(engine);
    this.#syncPending = engine.syncPending;
    this.#dirty = true;
    // Drain before emitting: a data listener may synchronously feed more output.
    const output = engine.takeOutput();
    const replies = replyToQueries ? output : new Uint8Array();
    // Finish all parser/policy changes before user callbacks can reenter feed.
    if (deferred !== undefined && deferred.length > 0) {
      const combined = new Uint8Array(deferred.length + replies.length);
      combined.set(deferred);
      combined.set(replies, deferred.length);
      this.#emit("data", combined);
    } else if (replies.length > 0) this.#emit("data", replies);
  }

  /**
   * Connect to a process. Output is fed in, and everything the user types is
   * written out — so a host that attaches a transport no longer needs to
   * listen for `data` itself.
   *
   * Attaching over an existing transport detaches the old one first, rather
   * than quietly ending up with two sockets writing to the same grid.
   * If an unsubscribe callback attaches or detaches, that newer operation
   * wins and this call does not attach its requested transport. Read
   * `transport` afterwards to discover the resulting attachment.
   */
  attach(transport: TerminalTransport): void {
    this.#assertLive("attach");
    const generation = this.#transportGeneration + 1;
    this.detach();
    // A newer attach/detach from an unsubscribe callback owns the result.
    if (this.#disposed || this.#transportGeneration !== generation) return;

    this.#transport = transport;
    const subscriptions: Array<() => void> = [];
    this.#transportOff = subscriptions;
    const subscribe = (unsubscribe: () => void): void => {
      if (this.#transportOff === subscriptions) subscriptions.push(unsubscribe);
      else unsubscribe();
    };

    try {
      // Install outbound writes before inbound callbacks. A transport is
      // allowed to synchronously replay output or report closure while a
      // listener is registered, and parser replies must already have a route.
      subscribe(this.on("data", (bytes) => transport.write(bytes)));
      subscribe(this.on("resize", (grid) => transport.resize(grid.columns, grid.lines)));
      subscribe(transport.onData((bytes, options) => this.feed(bytes, options)));
      subscribe(
        transport.onClose((reason) => {
          if (this.#transportOff !== subscriptions) return;
          this.detach();
          if (reason !== undefined) this.#emit("error", new Error(reason));
        }),
      );

      if (this.#transportOff === subscriptions) {
        // The grid is already measured by the time a host attaches, and the
        // process was spawned at whatever size the host guessed. Send the real
        // one immediately, or a full-screen program draws for the wrong grid
        // until the next resize — which may never come.
        transport.resize(this.#grid.columns, this.#grid.lines);
      }
    } catch (error) {
      if (this.#transportOff === subscriptions) this.detach();
      throw error;
    }
  }

  /** The currently attached transport, if any. */
  get transport(): TerminalTransport | undefined {
    return this.#transport;
  }

  /** Disconnect. Safe to call when nothing is attached. */
  detach(): void {
    this.#wheel.reset();
    this.#transportGeneration += 1;
    const subscriptions = this.#transportOff;
    this.#transportOff = [];
    this.#transport = undefined;
    for (const off of subscriptions) safely(off);
  }

  /** Inject local text without sending parser replies to the process. */
  write(text: string): void {
    this.feed(new TextEncoder().encode(text), { replyToQueries: false });
  }

  setOptions(patch: Partial<TerminalOptions>): void {
    if (this.#disposed) return;
    const previous = this.#options;
    const next = { ...previous, ...patch };
    next.scrollSensitivity = scrollSensitivity(next.scrollSensitivity);
    this.#options = next;
    if (
      next.scrollSensitivity !== previous.scrollSensitivity ||
      patch.font !== undefined ||
      patch.scrollback !== undefined
    ) {
      this.#wheel.reset();
    }

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
    if (this.#textInput === undefined) {
      this.#host.focus({ preventScroll: true });
      return;
    }
    this.#textInput.focus();
  }

  blur(): void {
    this.#textInput?.blur();
    if (this.#host.ownerDocument.activeElement === this.#host) this.#host.blur();
  }

  /**
   * Clear the scrollback and the screen, keeping the cursor's line — the
   * shell prompt — as the first row, like Cmd+K in Terminal.app or iTerm2.
   * The process is not told: a shell keeps editing its prompt in place.
   * Does nothing on the alternate screen, which a full-screen program owns.
   */
  clearScreen(): void {
    const engine = this.#requireEngine("clearScreen");
    // Output received before the clear must land first: a pending
    // synchronized batch would otherwise be applied on top of the cleared
    // grid, and the line kept would be a stale prompt.
    const deferred = this.#flushSync(true);
    if (!engine.altScreen) {
      engine.clearToCursorLine();
      this.#clearSelection();
      this.#wheel.reset();
      this.#dirty = true;
    }
    if (deferred !== undefined && deferred.length > 0) this.#emit("data", deferred);
  }

  scrollLines(delta: number): void {
    this.#scrollViewport(delta, false);
    this.#wheel.reset();
  }

  scrollToBottom(): void {
    const engine = this.#requireEngine("scrollToBottom");
    const before = engine.displayOffset;
    engine.resetScroll();
    // The content moved up by `before` lines: shift the selection anchors
    // with it so the highlight stays on the same text. Anchors may leave the
    // viewport — the highlight skips off-screen rows and getSelection still
    // resolves the full text via grid coordinates.
    this.#shiftSelection(-before, false);
    this.#wheel.reset();
    this.#dirty = true;
  }

  getSelection(): string | null {
    const start = this.#selectionStart;
    const end = this.#selectionEnd;
    if (start === null || end === null) return null;

    const engine = this.#requireEngine("getSelection");
    const [top, bottom] =
      start.line < end.line || (start.line === end.line && start.column <= end.column)
        ? [start, end]
        : [end, start];

    const text = engine.selectedText(top.line, top.column, bottom.line, bottom.column);
    return text === "" ? null : text;
  }

  async copySelection(): Promise<void> {
    const text = this.getSelection();
    if (text === null) return;
    await navigator.clipboard.writeText(text);
  }

  // --------------------------------------------------------------- internals

  #flushSync(force: boolean): Uint8Array | undefined {
    const engine = this.#engine;
    if (!this.#syncPending || engine === undefined || !engine.flushSync(force)) return;
    if (this.#wheel.pending) this.#wheel.syncRouting(engine);
    this.#syncPending = engine.syncPending;
    this.#dirty = true;
    const replies = engine.takeOutput();
    return this.#replyToQueries ? replies : undefined;
  }

  #draw(): void {
    this.#frame = 0;
    if (this.#disposed) return;

    try {
      const engine = this.#engine;
      const renderer = this.#renderer;
      if (engine === undefined || renderer === undefined) return;
      // Only feed can open a batch. Idle terminals never poll across WASM.
      const replies = this.#flushSync(false);
      if (this.#dirty) {
        try {
          engine.refreshSnapshot();
          const packed = new Uint32Array(
            engineMemory(),
            engine.snapshotPtr(),
            engine.snapshotLen(),
          );
          applySelectionHighlight(packed, engine.columns, this.#selectionStart, this.#selectionEnd);
          renderer.render({ columns: engine.columns, lines: engine.screenLines, packed });
          this.#dirty = false;
        } catch (error) {
          // A failed frame is not device loss. Keep the engine and retry.
          this.#emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      }
      // Host callbacks are not renderer failures. Render first, and let a
      // listener exception escape while the finally block keeps frames alive.
      if (!this.#disposed && replies !== undefined && replies.length > 0)
        this.#emit("data", replies);
    } finally {
      if (!this.#disposed) this.#frame = requestAnimationFrame(() => this.#draw());
    }
  }

  #handleRendererError(error: Error): void {
    if (this.#disposed) return;
    try {
      this.#emit("error", error);
    } finally {
      // A lost device cannot render a future frame. Clear the canvas and the
      // pending animation frame so the host can activate a compatibility path.
      this.dispose();
    }
  }

  #remeasure(): void {
    const atlas = this.#atlas;
    const engine = this.#engine;
    if (atlas === undefined || engine === undefined) return;

    const bounds = this.#surfaceBounds();
    const measured = measureSurface(bounds, atlas.cell, window.devicePixelRatio);
    if (measured === null) return;
    const cellHeight = atlas.cell.height / window.devicePixelRatio;
    if (cellHeight !== this.#wheelCellHeight) this.#wheel.reset();
    this.#wheelCellHeight = cellHeight;

    this.#canvas.width = measured.pixels.width;
    this.#canvas.height = measured.pixels.height;

    const changed = computeGridResize(this.#grid, measured.grid);
    if (changed === null) {
      this.#dirty = true;
      return;
    }
    engine.resize(changed.columns, changed.lines);
    this.#wheel.reset();
    this.#grid = changed;
    this.#selectionStart = clampCellPoint(this.#selectionStart, changed);
    this.#selectionEnd = clampCellPoint(this.#selectionEnd, changed);
    this.#selectionAnchor = clampCellPoint(this.#selectionAnchor, changed);
    this.#selectionFocus = clampCellPoint(this.#selectionFocus, changed);
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
    if (this.#engine === undefined || isCompositionKey(event)) return;
    if (handleKeyDown(this.#buildState(), event, encodeKey)) {
      this.#wheel.reset();
      // `preventDefault` normally keeps a physical key from also producing an
      // input event. The guard covers browser/editor combinations that emit
      // both anyway, without suppressing later virtual-keyboard tasks.
      this.#textInput?.suppressInputForCurrentTask();
    }
  }

  #sendText(text: string, paste: boolean): void {
    const engine = this.#engine;
    if (engine === undefined || text === "") return;

    const normalized = paste ? text.replace(/\r?\n/g, "\r") : text;
    // Remove escape introducers rather than only complete delimiters: deleting
    // one nested delimiter must not synthesize another paste terminator.
    // eslint-disable-next-line no-control-regex -- Strip control introducers to prevent bracketed-paste injection.
    const safePaste = normalized.replace(/[\x1b\x9b]/g, "");
    const payload = paste && engine.bracketedPaste ? `\x1b[200~${safePaste}\x1b[201~` : normalized;
    this.#clearSelection();
    engine.resetScroll();
    this.#wheel.reset();
    this.#dirty = true;
    this.#emit("data", new TextEncoder().encode(payload));
  }

  readonly #sendPointer = (
    kind: number,
    button: number,
    event: MouseEvent | WheelEvent,
  ): boolean => {
    const engine = this.#engine;
    const atlas = this.#atlas;
    if (engine === undefined || atlas === undefined) return false;
    return sendPointerToEngine(
      engine,
      atlas,
      this.#surfaceBounds,
      window.devicePixelRatio,
      kind,
      button,
      event,
      (bytes) => this.#emit("data", bytes),
    );
  };

  #buildState(): InputHandlerState {
    const engine = this.#engine;
    const atlas = this.#atlas;

    return {
      engine,
      emit: (event, payload) => this.#emit(event as TerminalEvent, payload as never),
      clearSelection: () => this.#clearSelection(),
      cellAt: (event) =>
        atlas ? computeCellPoint(atlas, this.#surfaceBounds, event, this.#grid) : null,
      sendPointer: this.#sendPointer,
      dragging: this.#dragging,
      setDragging: (v) => {
        this.#dragging = v;
      },
      beginSelection: (event, kind) => {
        this.#selectionKind = kind;
        this.#selectionAnchor = this.#selectionPointAt(event);
        this.#updateSelection(this.#selectionAnchor);
      },
      extendSelection: (event) => this.#updateSelection(this.#selectionPointAt(event)),
      selectionAnchor: this.#selectionAnchor,
      selectionKind: this.#selectionKind,
      hasSelection: () => this.#selectionStart !== null,
      activateLink: (link) => {
        this.#cancelLinkActivation();
        this.#linkTimer = setTimeout(() => {
          this.#linkTimer = undefined;
          this.#emit("link-activate", link);
        }, LINK_ACTIVATION_DELAY_MS);
      },
      dirty: this.#dirty,
      setDirty: (v) => {
        this.#dirty = v;
      },
      host: { focus: () => this.focus() },
      linkAt: (event) => {
        if (engine === undefined || atlas === undefined) return null;
        const cell = computeCellPoint(atlas, this.#surfaceBounds, event, this.#grid, "link");
        if (cell === null) return null;
        return resolveLinkUrl(engine, cell);
      },
    };
  }

  #handleMouseDown(event: MouseEvent): void {
    this.#stopDragScroll();
    // Any press within the wait makes the pending link click part of a
    // double click, or a new gesture altogether.
    this.#cancelLinkActivation();
    handleMouseDown(this.#buildState(), event, toEncoderButton, MOUSE_PRESS);
  }

  #handleMouseMove(event: MouseEvent): void {
    if (this.#dragging) this.#autoScrollDrag(event);
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
        const cell = computeCellPoint(atlas, this.#surfaceBounds, event, this.#grid, "link");
        if (cell === null) return null;
        return resolveLinkUrl(engine, cell);
      },
      { current: this.#hoveredLink },
    );
    const atlas = this.#atlas;
    const cell = atlas
      ? computeCellPoint(atlas, this.#surfaceBounds, event, this.#grid, "link")
      : null;
    const url = cell ? resolveLinkUrl(this.#engine!, cell) : null;
    this.#hoveredLink = url;
  }

  #handleMouseUp(event: MouseEvent): void {
    this.#stopDragScroll();
    handleMouseUp(this.#buildState(), event, toEncoderButton, MOUSE_RELEASE, () =>
      this.getSelection(),
    );
  }

  #handleWheel(event: WheelEvent): void {
    const engine = this.#engine;
    if (engine === undefined || this.#atlas === undefined) return;
    handleWheel(
      {
        engine,
        sendPointer: this.#sendPointer,
        wheel: this.#wheel,
        cellHeight: this.#wheelCellHeight,
        pageLines: this.#grid.lines,
        sensitivity: this.#options.scrollSensitivity!,
      },
      event,
      MOUSE_SCROLL_UP,
      MOUSE_SCROLL_DOWN,
      (delta) => this.#scrollViewport(delta, false),
    );
  }

  /**
   * Scroll the viewport while a selection drag sits past a viewport edge, and
   * keep scrolling on a timer: `mousemove` stops firing once the pointer rests
   * outside the surface, but the user still expects the selection to keep
   * extending into scrollback until the button is released.
   */
  #autoScrollDrag(event: MouseEvent): void {
    const atlas = this.#atlas;
    const engine = this.#engine;
    if (atlas === undefined || engine === undefined) return;

    const bounds = this.#surfaceBounds();
    const delta = dragAutoScrollLines(
      { top: bounds.top, bottom: bounds.bottom },
      atlas.cell.height / window.devicePixelRatio,
      event.clientY,
    );
    if (delta === 0) {
      this.#stopDragScroll();
      return;
    }
    this.#applyDragScroll(delta);
    this.#dragScrollDelta = delta;
    if (this.#dragScrollTimer === undefined) {
      this.#dragScrollTimer = setInterval(() => this.#dragScrollTick(), 50);
    }
  }

  #dragScrollTick(): void {
    const moved = this.#applyDragScroll(this.#dragScrollDelta);
    if (moved === 0) {
      this.#stopDragScroll();
      return;
    }
    // No mousemove event will pin the end anchor while the pointer rests
    // outside the surface, so pin it to the edge the drag is crossing.
    const focus = this.#selectionFocus;
    this.#updateSelection(
      clampCellPoint(
        {
          line: this.#dragScrollDelta > 0 ? 0 : this.#grid.lines - 1,
          column: focus?.column ?? 0,
          right: focus?.right ?? false,
        },
        this.#grid,
      ),
    );
  }

  /**
   * Scroll the viewport by `delta` lines and re-anchor the selection on the
   * same content. Viewport-relative anchors must move with the content:
   * scrolling up (positive delta) pushes content down, so anchors shift down
   * by the number of lines actually moved. Returns the effective movement.
   *
   * When `clampLines` is false (wheel scroll), anchors may leave the viewport
   * — the highlight skips off-screen rows and getSelection still resolves the
   * full text. When true (drag auto-scroll), anchors stay clamped to the grid
   * because the pointer is physically at the edge.
   */
  #scrollViewport(delta: number, clampLines: boolean): number {
    const engine = this.#engine;
    if (engine === undefined || delta === 0) return 0;
    const before = engine.displayOffset;
    engine.scrollLines(delta);
    const moved = engine.displayOffset - before;
    if (moved === 0) return 0;
    this.#shiftSelection(moved, clampLines);
    this.#dirty = true;
    return moved;
  }

  /** Move every selection point down by `delta` viewport lines, with the content. */
  #shiftSelection(delta: number, clampLines: boolean): void {
    this.#selectionStart = shiftCellPoint(this.#selectionStart, delta, this.#grid, clampLines);
    this.#selectionEnd = shiftCellPoint(this.#selectionEnd, delta, this.#grid, clampLines);
    this.#selectionAnchor = shiftCellPoint(this.#selectionAnchor, delta, this.#grid, clampLines);
    this.#selectionFocus = shiftCellPoint(this.#selectionFocus, delta, this.#grid, clampLines);
  }

  #selectionPointAt(event: MouseEvent): SelectionPoint | null {
    const atlas = this.#atlas;
    return atlas ? selectionPointAt(atlas, this.#surfaceBounds, event, this.#grid) : null;
  }

  /**
   * Move the selection's free end to `focus` and let the engine resolve the
   * covered cells: half-cell sides for a drag, whole words or lines for a
   * double or triple click. Covering no cell means no selection.
   */
  #updateSelection(focus: SelectionPoint | null): void {
    this.#selectionFocus = focus;
    const anchor = this.#selectionAnchor;
    const range =
      anchor === null || focus === null
        ? undefined
        : this.#engine?.selectionRange(
            this.#selectionKind,
            anchor.line,
            anchor.column,
            anchor.right,
            focus.line,
            focus.column,
            focus.right,
          );
    this.#selectionStart = range === undefined ? null : { line: range[0], column: range[1] };
    this.#selectionEnd = range === undefined ? null : { line: range[2], column: range[3] };
    this.#dirty = true;
  }

  /** Scroll by `delta` lines during a drag, keeping anchors clamped to the grid. */
  #applyDragScroll(delta: number): number {
    return this.#scrollViewport(delta, true);
  }

  #cancelLinkActivation(): void {
    if (this.#linkTimer !== undefined) clearTimeout(this.#linkTimer);
    this.#linkTimer = undefined;
  }

  #stopDragScroll(): void {
    if (this.#dragScrollTimer !== undefined) clearInterval(this.#dragScrollTimer);
    this.#dragScrollTimer = undefined;
    this.#dragScrollDelta = 0;
  }

  #clearSelection(): void {
    this.#selectionAnchor = null;
    this.#selectionFocus = null;
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
