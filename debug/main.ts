import { createWebGpuRenderer, resolveAlacrittyToml, Terminal } from "../src/index";
import type { RendererGrid, TerminalCursor, TerminalOptions, TerminalPalette } from "../src/index";
import { WebSocketTransport } from "../src/transport/index";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing #${id}`);
  return value as T;
}

const host = element<HTMLDivElement>("terminal");
const status = element("status");
const start = element<HTMLButtonElement>("start");
const stop = element<HTMLButtonElement>("stop");
const shell = element<HTMLSelectElement>("shell");
const clean = element<HTMLInputElement>("clean");
const cursor = element<HTMLSelectElement>("cursor");
const blink = element<HTMLInputElement>("blink");
const color = element<HTMLInputElement>("cursor-color");
const family = element<HTMLInputElement>("font-family");
const size = element<HTMLInputElement>("font-size");
const trace = element<HTMLInputElement>("trace");
const log = element("log");
const previewButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".preview-buttons button"),
);
const palette: TerminalPalette = {
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
};
let options: TerminalOptions = {
  font: { family: "monospace", size: 15 },
  colors: { ...palette },
  cursor: { style: "block", blink: false },
  scrollback: 10000,
};
let frames = 0;
let rx = 0;
let tx = 0;
let grid = { columns: 80, lines: 24 };
let effectiveCursor: { shape: string; line: number; column: number; visible: boolean } | null =
  null;
let transport: WebSocketTransport | undefined;
let generation = 0;
let hidden = false;
const entries: string[] = [];

function record(message: string): void {
  entries.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
  if (entries.length > 60) entries.shift();
  log.textContent = entries.join("\n");
  log.scrollTop = log.scrollHeight;
}

function setStatus(message: string, state = "ready"): void {
  status.textContent = message;
  status.dataset.state = state;
}

function bytes(direction: string, value: Uint8Array): void {
  if (!trace.checked) return;
  const escaped = Array.from(value.subarray(0, 256), (byte) =>
    byte >= 32 && byte < 127
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, "0")}`,
  ).join("");
  record(`${direction} ${value.length} B ${escaped}${value.length > 256 ? "…" : ""}`);
}

function observeFrame(value: RendererGrid): void {
  frames++;
  updateTraffic();
  grid = { columns: value.columns, lines: value.lines };
  effectiveCursor = null;
  for (let index = 0; index < value.columns * value.lines; index++) {
    const flags = value.packed[index * 4 + 3];
    const shape =
      flags & (1 << 16)
        ? "block"
        : flags & (1 << 17)
          ? "beam"
          : flags & (1 << 18)
            ? "underline"
            : null;
    if (shape === null) continue;
    effectiveCursor = {
      shape,
      line: Math.floor(index / value.columns),
      column: index % value.columns,
      visible: value.cursorVisible !== false,
    };
    break;
  }
  element("effective-cursor").textContent = effectiveCursor?.shape ?? "hidden / off-screen";
  element("cursor-phase").textContent =
    effectiveCursor === null ? "—" : effectiveCursor.visible ? "visible" : "blink off";
  element("grid").textContent = `${grid.columns} × ${grid.lines}`;
  element("dpr").textContent = String(devicePixelRatio);
}

function updateTraffic(): void {
  element("traffic").textContent = `RX ${rx} B · TX ${tx} B · ${frames} frames`;
}

// Same ownership model as CadencR: appearance updates preserve the renderer
// and PTY; only starting/stopping a session replaces the transport.
const terminal = new Terminal(host, options, async (canvas, atlas) => {
  const renderer = await createWebGpuRenderer(canvas, atlas);
  const render = renderer.render.bind(renderer);
  renderer.render = (value) => {
    render(value);
    observeFrame(value);
  };
  return renderer;
});
terminal.on("error", (error) => {
  record(`ERROR ${error.message}`);
  setStatus(error.message, "error");
});
terminal.on("diagnostic", (error) => record(`GPU ${error.message}`));
terminal.on("resize", (value) => {
  grid = value;
  record(`RESIZE ${value.columns} × ${value.lines}`);
});

function sessionControls(connected: boolean): void {
  stop.disabled = !connected;
  start.textContent = connected ? "Restart shell" : "Start shell";
  for (const button of previewButtons) button.disabled = connected;
}

function disconnect(): void {
  generation++;
  terminal.detach();
  transport?.close();
  transport = undefined;
  sessionControls(false);
}

function preview(): void {
  terminal.write(
    "\x1bcCeleriTTY cursor playground\r\n\r\n" +
      "Choose a default cursor in Appearance.\r\n" +
      "The ANSI buttons simulate an application's override.\r\n\r\n" +
      "Cursor here: ",
  );
  hidden = false;
  element("session-title").textContent = "Cursor playground";
  setStatus("Playground ready");
  terminal.focus();
}

async function connect(): Promise<void> {
  disconnect();
  const current = generation;
  terminal.write("\x1bc");
  hidden = false;
  const url = new URL("/__debug/pty", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("shell", shell.value);
  url.searchParams.set("clean", String(clean.checked));
  const socket = new WebSocketTransport(url, {
    onReady: () => {
      if (current !== generation) return;
      socket.resize(grid.columns, grid.lines);
      setStatus("Shell connected");
      record(`CONNECTED ${shell.value}, skip configuration=${clean.checked}`);
      terminal.focus();
    },
    onExit: (code) => {
      if (current === generation) {
        record(`EXIT ${code}`);
        setStatus(`Shell exited (${code})`);
      }
    },
  });
  transport = socket;
  socket.onClose((reason) => {
    if (current !== generation) return;
    sessionControls(false);
    transport = undefined;
    if (reason !== undefined) {
      record(`CONNECTION ${reason}`);
      setStatus(reason, "error");
    } else record("DISCONNECTED");
  });
  terminal.attach({
    write(value) {
      tx += value.length;
      bytes("TX", value);
      socket.write(value);
    },
    resize: (columns, rows) => socket.resize(columns, rows),
    onData: (listener) =>
      socket.onData((value) => {
        rx += value.length;
        bytes("RX", value);
        listener(value);
      }),
    onClose: (listener) => socket.onClose(listener),
  });
  sessionControls(true);
  setStatus("Connecting…");
  element("session-title").textContent = shell.selectedOptions[0].textContent;
  try {
    await socket.opened;
  } catch (error) {
    if (current === generation) record(String(error));
  }
}

function applyOptions(): void {
  terminal.setOptions(options);
  host.style.background = options.colors.background;
  terminal.focus();
  record(
    `OPTIONS ${options.cursor.style}, blink=${options.cursor.blink}, ${options.font.family} ${options.font.size}px`,
  );
}

async function main(): Promise<void> {
  const response = await fetch("/__debug/config");
  if (!response.ok) throw new Error(`PTY configuration returned HTTP ${response.status}`);
  const config = (await response.json()) as {
    shells: Array<{ id: string; label: string; path: string }>;
    cwd: string;
  };
  for (const item of config.shells) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.label} (${item.path})`;
    shell.append(option);
  }
  element("cwd").textContent = config.cwd;
  await terminal.ready;
  start.disabled = config.shells.length === 0;
  element<HTMLButtonElement>("focus").disabled = false;
  preview();
  start.onclick = () =>
    void connect().catch((error: unknown) => {
      record(`CONNECTION ${String(error)}`);
      setStatus(String(error), "error");
    });
  stop.onclick = () => {
    disconnect();
    preview();
    record("STOPPED shell");
  };
  element("focus").onclick = () => terminal.focus();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-sequence]")) {
    button.onclick = () => {
      const parameter = button.dataset.sequence!;
      terminal.write(`\x1b[?25h\x1b[${parameter} q`);
      hidden = false;
      record(`LOCAL DECSCUSR ${parameter}`);
      terminal.focus();
    };
  }
  element("hide-cursor").onclick = () => {
    hidden = !hidden;
    terminal.write(hidden ? "\x1b[?25l" : "\x1b[?25h");
    record(`LOCAL cursor ${hidden ? "hidden" : "shown"}`);
    terminal.focus();
  };
  for (const control of [cursor, blink, color])
    control.addEventListener("change", () => {
      options = {
        ...options,
        cursor: { style: cursor.value as TerminalCursor["style"], blink: blink.checked },
        colors: { ...options.colors, cursor: color.value },
      };
      applyOptions();
    });
  for (const control of [family, size])
    control.addEventListener("change", () => {
      const fontSize = Number(size.value);
      if (family.value.trim() === "" || !size.checkValidity() || !Number.isFinite(fontSize)) return;
      options = { ...options, font: { ...options.font, family: family.value, size: fontSize } };
      applyOptions();
    });
  element<HTMLSelectElement>("theme").onchange = (event) => {
    const light = (event.target as HTMLSelectElement).value === "light";
    options = {
      ...options,
      colors: {
        ...palette,
        foreground: light ? "#202a3b" : palette.foreground,
        background: light ? "#f5f7fa" : palette.background,
        cursor: color.value,
      },
    };
    applyOptions();
  };
  element<HTMLInputElement>("config-file").onchange = async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file === undefined) return;
    try {
      options = resolveAlacrittyToml(await file.text(), options.colors);
      cursor.value = options.cursor.style;
      blink.checked = options.cursor.blink;
      color.value = options.colors.cursor;
      family.value = options.font.family;
      size.value = String(options.font.size);
      applyOptions();
      record(`CONFIG loaded ${file.name}`);
    } catch (error) {
      record(`CONFIG ${String(error)}`);
    }
  };
  element("clear-log").onclick = () => {
    entries.length = 0;
    log.textContent = "";
  };
  element("report").onclick = () => {
    const report = {
      options,
      grid,
      effectiveCursor,
      rx,
      tx,
      frames,
      dpr: devicePixelRatio,
      userAgent: navigator.userAgent,
      log: entries,
      timestamp: new Date().toISOString(),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "celeritty-debug.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

const trafficTimer = setInterval(updateTraffic, 500);
function dispose(): void {
  disconnect();
  terminal.dispose();
  clearInterval(trafficTimer);
}
window.addEventListener("pagehide", dispose, { once: true });
import.meta.hot?.dispose(dispose);
void main().catch((error: unknown) => {
  record(`STARTUP ${String(error)}`);
  setStatus(String(error), "error");
});
