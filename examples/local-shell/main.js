import "celeritty/element";
import { WebSocketTransport } from "celeritty/transport/websocket";

// The xterm default palette. Any 19 colours work; the component applies what
// it is given and resolves nothing.
const colors = {
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

const term = document.getElementById("term");

term.options = {
  font: { family: "monospace", size: 13 },
  colors,
  cursor: { style: "block", blink: false },
  scrollback: 10000,
};

term.transport = new WebSocketTransport("ws://localhost:8080");

// URLs in the output open in a new tab on click by default; no listener needed.

term.addEventListener("error", (event) => {
  console.error("terminal:", event.detail);
});
