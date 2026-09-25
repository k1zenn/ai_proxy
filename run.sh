#!/usr/bin/env bash
# Convenience launcher for thinking-fix-proxy.
#
# Default upstream comes from config.json (https://agentrouter.org).
# Override anything via env, e.g.:
#
#   HOST=0.0.0.0 ./run.sh
#   UPSTREAM=https://other-gateway.example.com ./run.sh
#
set -euo pipefail
cd "$(dirname "$0")"
exec node server.mjs
