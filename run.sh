#!/usr/bin/env bash
# Convenience launcher for thinking-fix-proxy.
#
# Runs the proxy in the foreground. Ctrl+C stops it and frees the port.
#
# If the port is already taken — by the systemd `ai-proxy` unit or by a
# previous proxy that is still running — it is stopped automatically, so you
# never have to hunt for a PID. Anything else on the port is reported, not
# killed.
#
# Default upstream comes from config.json (https://agentrouter.org).
# Override anything via env, e.g.:
#
#   HOST=0.0.0.0 ./run.sh
#   UPSTREAM=https://other-gateway.example.com ./run.sh
#   PORT=8788 ./run.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# Resolve host/port the same way server.mjs does:
#   env > config.json > built-in default.
resolve() {
  node -e "try{const c=require('./config.json');process.stdout.write(String(c['$1']||''))}catch(e){}" 2>/dev/null || true
}

PORT="${PORT:-$(resolve port)}"
PORT="${PORT:-8787}"
HOST="${HOST:-$(resolve host)}"
HOST="${HOST:-127.0.0.1}"

listener_pid() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
  elif command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
  fi
}

# 1. The systemd unit owns the port after a reboot; stop it cleanly so it does
#    not fight us (and does not auto-restart).
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet ai-proxy 2>/dev/null; then
  echo "==> stopping systemd ai-proxy so run.sh can own port $PORT"
  systemctl --user stop ai-proxy || true
fi

# 2. A previous proxy (from an earlier terminal) may still hold the port.
EXISTING="$(listener_pid || true)"
if [ -n "${EXISTING:-}" ]; then
  EXISTING_CMD="$(ps -o args= -p "$EXISTING" 2>/dev/null || true)"
  if printf '%s' "$EXISTING_CMD" | grep -q 'server\.mjs'; then
    echo "==> stopping previous proxy (pid $EXISTING) on port $PORT"
    kill "$EXISTING" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$EXISTING" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$EXISTING" 2>/dev/null || true
  else
    {
      echo "error: port $PORT is already in use by pid $EXISTING"
      echo "       $EXISTING_CMD"
      echo "Stop it, or start the proxy on another port:  PORT=8788 ./run.sh"
    } >&2
    exit 1
  fi
fi

# 3. Run in the background so we can trap Ctrl+C and clean up the pidfile.
node server.mjs &
PID=$!
echo "$PID" > proxy.pid

cleanup() {
  trap - INT TERM EXIT
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f proxy.pid
}
trap cleanup INT TERM EXIT

wait "$PID"
