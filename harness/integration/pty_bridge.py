"""Isolated real PTY fixture; JSON/base64 on stdio, no network shell service."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

home, columns, lines = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.chdir(home)
    os.environ.update(HOME=home, TERM="xterm-256color", COLORTERM="truecolor", PS1="QA_SHELL> ", NVIM_LOG_FILE=os.path.join(home, "nvim.log"))
    os.environ.pop("ENV", None)
    os.execv("/bin/sh", ["sh", "-i"])


def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


resize(int(columns), int(lines))
pending = b""
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            print(json.dumps({"output": base64.b64encode(data).decode("ascii")}), flush=True)
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                command = json.loads(line)
                if command.get("close"):
                    raise SystemExit(0)
                if "input" in command:
                    payload = base64.b64decode(command["input"])
                    while payload:
                        payload = payload[os.write(master, payload):]
                if "resize" in command:
                    resize(*command["resize"])
finally:
    # Only the fixture's own foreground process group and shell are signaled.
    try:
        foreground = os.tcgetpgrp(master)
        if foreground > 0 and foreground != os.getpgrp():
            os.killpg(foreground, signal.SIGHUP)
    except (OSError, ProcessLookupError):
        pass
    os.close(master)
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
