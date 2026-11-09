/** Development-only PTY bridge using the reference binary WebSocket protocol. */
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import type { Plugin } from "vite";
import { WebSocket, WebSocketServer } from "ws";

interface Shell {
  id: string;
  label: string;
  path: string;
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function executable(command: string): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "").split(":").map((directory) => join(directory, command));
  return candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function availableShells(): Shell[] {
  const shells: Shell[] = [];
  for (const [id, label, command] of [
    ["default", "Default shell", process.env.SHELL ?? "/bin/sh"],
    ["fish", "Fish", "fish"],
    ["zsh", "Zsh", "zsh"],
    ["bash", "Bash", "bash"],
    ["sh", "POSIX sh", "/bin/sh"],
  ]) {
    const path = executable(command);
    if (path !== undefined) shells.push({ id, label, path });
  }
  return shells;
}

export function localPty(): Plugin {
  let cleanup = (): void => {};
  return {
    name: "celeritty-local-pty",
    closeBundle: () => cleanup(),
    configureServer(server) {
      // Some node-pty 1.1 prebuilds ship this helper without its execute bit.
      // Repair the installed dependency so contributors need no manual chmod.
      if (process.platform === "darwin") {
        const directory = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
        for (const helper of [
          join(directory, "prebuilds", `darwin-${process.arch}`, "spawn-helper"),
          join(directory, "build", "Release", "spawn-helper"),
        ]) {
          if (existsSync(helper)) {
            const mode = statSync(helper).mode;
            if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o111);
          }
        }
      }
      const shells = availableShells();
      const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
      const sessions = new Map<WebSocket, pty.IPty>();
      server.middlewares.use("/__debug/config", (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ shells, cwd: ROOT }));
      });
      server.httpServer?.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/__debug/pty") return; // Leave Vite HMR alone.
        // A local shell must only accept a connection from its own page.
        let sameOrigin = false;
        try {
          sameOrigin = new URL(request.headers.origin ?? "").host === request.headers.host;
        } catch {
          // A missing or malformed Origin is not our browser page.
        }
        if (!sameOrigin) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        const shell = shells.find((candidate) => candidate.id === url.searchParams.get("shell"));
        if (shell === undefined) {
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          return;
        }
        sockets.handleUpgrade(request, socket, head, (client) => {
          let term: pty.IPty;
          try {
            const clean = url.searchParams.get("clean") === "true";
            const env: NodeJS.ProcessEnv = {
              ...process.env,
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
            };
            if (clean) {
              delete env.ENV;
              delete env.BASH_ENV;
            }
            const args = clean
              ? shell.path.endsWith("/fish")
                ? ["--no-config", "-i"]
                : shell.path.endsWith("/zsh")
                  ? ["-f", "-i"]
                  : shell.path.endsWith("/bash")
                    ? ["--noprofile", "--norc", "-i"]
                    : ["-i"]
              : ["-l"];
            term = pty.spawn(shell.path, args, {
              name: "xterm-256color",
              cols: 80,
              rows: 24,
              cwd: ROOT,
              env,
              encoding: null,
            });
          } catch (error) {
            client.send(JSON.stringify({ type: "error", message: String(error) }));
            client.close();
            return;
          }
          sessions.set(client, term);
          client.send(JSON.stringify({ type: "ready", columns: 80, rows: 24 }));
          const data = term.onData((chunk) => {
            if (client.readyState === WebSocket.OPEN) client.send(chunk, { binary: true });
          });
          const exit = term.onExit(({ exitCode }) => {
            sessions.delete(client);
            if (client.readyState !== WebSocket.OPEN) return;
            client.send(JSON.stringify({ type: "exit", code: exitCode }));
            client.close();
          });
          client.on("message", (payload, binary) => {
            if (binary) {
              term.write(payload as Buffer);
              return;
            }
            try {
              const message = JSON.parse(payload.toString()) as Record<string, unknown>;
              if (
                message.type !== "resize" ||
                !Number.isInteger(message.columns) ||
                !Number.isInteger(message.rows) ||
                (message.columns as number) < 1 ||
                (message.rows as number) < 1 ||
                (message.columns as number) > 1000 ||
                (message.rows as number) > 1000
              )
                throw new Error("Invalid resize frame");
              term.resize(message.columns as number, message.rows as number);
            } catch (error) {
              if (client.readyState === WebSocket.OPEN)
                client.send(JSON.stringify({ type: "error", message: String(error) }));
            }
          });
          client.on("error", () => client.close());
          client.on("close", () => {
            data.dispose();
            exit.dispose();
            if (sessions.delete(client)) term.kill();
          });
        });
      });
      cleanup = () => {
        for (const [client, term] of sessions) {
          client.terminate();
          term.kill();
        }
        sessions.clear();
        sockets.close();
      };
      server.httpServer?.once("close", cleanup);
    },
  };
}
