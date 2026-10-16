#!/usr/bin/env python3
"""Supervise the private bridge and its dedicated tunnel without root."""

import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time


BASE = Path(__file__).resolve().parent
SHARED = BASE / "shared"
PIDFILE = SHARED / "supervisor.pid"
MAX_BRIDGE_LOG_LINE = 64 * 1024
SAFE_BRIDGE_MESSAGES = {
    "Failed to close WhatsApp socket cleanly",
    "Failed to delete chats",
    "Failed to persist chat list",
    "Failed to persist incoming message",
    "Failed to persist WhatsApp credentials",
    "WhatsApp reconnect failed",
    "event publish failed",
    "private WhatsApp MCP listening",
    "request failed",
}
SAFE_ERROR_NAMES = {"AggregateError", "Boom", "Error", "EventsError", "OAuthError", "TypeError"}
SAFE_ERROR_CODES = {
    "EACCES",
    "EADDRINUSE",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOENT",
    "ETIMEDOUT",
    "insufficient_scope",
    "invalid_token",
}


def filter_bridge_log_line(line):
    """Return compact safe metadata from one Pino JSON line, or discard it."""
    if not isinstance(line, str) or len(line.encode("utf-8", "replace")) > MAX_BRIDGE_LOG_LINE:
        return None
    try:
        source = json.loads(line)
    except (TypeError, ValueError, RecursionError):
        return None
    if not isinstance(source, dict):
        return None

    safe = {}
    numeric_fields = {
        "level": (0, 60),
        "time": (0, 100_000_000_000_000),
        "pid": (1, 2_147_483_647),
        "dropped": (0, 1_000_000),
    }
    for field, (minimum, maximum) in numeric_fields.items():
        value = source.get(field)
        if isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum:
            safe[field] = value
    port = source.get("port")
    if isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535:
        safe["port"] = port
    host = source.get("host")
    if isinstance(host, str) and host in {"127.0.0.1", "localhost"}:
        safe["host"] = host
    error_name = source.get("errorName")
    if isinstance(error_name, str) and error_name in SAFE_ERROR_NAMES:
        safe["errorName"] = error_name
    error_code = source.get("errorCode")
    if isinstance(error_code, int) and not isinstance(error_code, bool) and -32768 <= error_code <= 65535:
        safe["errorCode"] = error_code
    elif isinstance(error_code, str) and error_code in SAFE_ERROR_CODES:
        safe["errorCode"] = error_code
    message = source.get("msg")
    if isinstance(message, str) and message in SAFE_BRIDGE_MESSAGES:
        safe["msg"] = message
    if not safe:
        return None
    return json.dumps(safe, ensure_ascii=False, separators=(",", ":"))


def filter_bridge_log_chunk(remainder, chunk):
    """Split non-blocking output safely without ever returning raw bridge bytes."""
    combined = remainder + chunk
    lines = combined.split(b"\n")
    remainder = lines.pop()
    if len(remainder) > MAX_BRIDGE_LOG_LINE:
        remainder = b""
    records = []
    for raw_line in lines:
        if len(raw_line) > MAX_BRIDGE_LOG_LINE:
            continue
        record = filter_bridge_log_line(raw_line.decode("utf-8", "replace").strip())
        if record is not None:
            records.append(record)
    return remainder, records


def stop_existing():
    try:
        pid = int(PIDFILE.read_text().strip())
        command = Path(f"/proc/{pid}/cmdline").read_bytes()
        if str(BASE / "supervise.py").encode() in command:
            os.kill(pid, signal.SIGTERM)
    except (FileNotFoundError, ProcessLookupError, ValueError):
        pass


def main():
    if "--stop" in sys.argv:
        stop_existing()
        return
    os.umask(0o077)
    SHARED.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (SHARED / "supervisor.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    PIDFILE.write_text(str(os.getpid()))
    log_dir = SHARED / "logs"
    log_dir.mkdir(mode=0o700, exist_ok=True)
    log = logging.getLogger("baileys-dot")
    log.setLevel(logging.INFO)
    handler = RotatingFileHandler(log_dir / "service.log", maxBytes=1024 * 1024, backupCount=2)
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    log.addHandler(handler)
    env = {"PATH": f"{BASE}/runtime/node/bin:/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home()), "LANG": "C.UTF-8"}
    env.update(json.loads((SHARED / "settings.json").read_text()))
    commands = {
        "bridge": [str(BASE / "runtime/node/bin/node"), str(BASE / "current/server.mjs")],
        "tunnel": ["/usr/local/bin/cloudflared", "tunnel", "--no-autoupdate", "--loglevel", "error", "--metrics", "127.0.0.1:4392", "run", "--token-file", str(SHARED / "cloudflared.token")],
    }
    selector = selectors.DefaultSelector()
    processes = {}
    bridge_log_remainders = {}
    restart_at = {name: 0 for name in commands}
    stopping = False

    def stop(signum, frame):
        nonlocal stopping
        stopping = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    try:
        while not stopping:
            for name, command in commands.items():
                child = processes.get(name)
                if child and child.poll() is not None:
                    log.warning("%s exited code=%s; retry in 10s", name, child.returncode)
                    try:
                        selector.unregister(child.stdout)
                    except KeyError:
                        pass
                    child.stdout.close()
                    del processes[name]
                    bridge_log_remainders.pop(name, None)
                    restart_at[name] = time.monotonic() + 10
                if name not in processes and time.monotonic() >= restart_at[name]:
                    child = subprocess.Popen(command, cwd=BASE / "current", env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
                    os.set_blocking(child.stdout.fileno(), False)
                    processes[name] = child
                    selector.register(child.stdout, selectors.EVENT_READ, name)
                    if name == "bridge":
                        bridge_log_remainders[name] = b""
                    log.info("%s started pid=%s", name, child.pid)
            for key, _ in selector.select(timeout=1):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if chunk:
                    if key.data == "bridge":
                        remainder, records = filter_bridge_log_chunk(bridge_log_remainders.get(key.data, b""), chunk)
                        bridge_log_remainders[key.data] = remainder
                        for record in records:
                            log.warning("%s %s", key.data, record)
                    else:
                        log.warning("%s %s", key.data, chunk.decode("utf-8", "replace").strip())
                else:
                    selector.unregister(key.fileobj)
                    bridge_log_remainders.pop(key.data, None)
    finally:
        for child in processes.values():
            if child.poll() is None:
                child.terminate()
        for child in processes.values():
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        selector.close()
        PIDFILE.unlink(missing_ok=True)
        log.info("supervisor stopped")


if __name__ == "__main__":
    main()
