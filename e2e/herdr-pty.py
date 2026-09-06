#!/usr/bin/env python3
"""Spawn Herdr attached to a real PTY and keep it alive."""

from __future__ import annotations

import os
import pty
import select
import signal
import sys
import time


def main() -> int:
    session = sys.argv[1] if len(sys.argv) > 1 else "canvas-e2e"
    os.environ.setdefault("TERM", "xterm-256color")
    os.environ.setdefault("SHELL", "/bin/bash")

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("herdr", ["herdr", "--session", session, "server"])

    def handle_stop(signum: int, _frame: object) -> None:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    try:
        while True:
            ready, _, _ = select.select([fd], [], [], 0.5)
            if ready:
                try:
                    data = os.read(fd, 8192)
                except OSError:
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
            else:
                time.sleep(0.05)
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
