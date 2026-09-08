#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=""
GLOBAL=""
for arg in "$@"; do
  case "$arg" in
    --global) GLOBAL="--global" ;;
    *) TARGET="$arg" ;;
  esac
done

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
node_minor="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || true)"
if [[ -z "$node_major" ]] || (( node_major < 22 )) || (( node_major >= 25 )) || { (( node_major == 22 )) && (( node_minor < 5 )); }; then
  echo "lazy-intel requires Node >=22.5 and <25; found ${node_major:-none}.${node_minor:-0}" >&2
  echo "Select a supported runtime first, e.g.:" >&2
  echo "  PATH=\"\$(brew --prefix node@22)/bin:\$PATH\" ./scripts/install.sh $*" >&2
  exit 1
fi

npm install

if ! command -v uv >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install uv
  else
    echo "uv is required for Serena. Install uv, then rerun." >&2
    exit 1
  fi
fi
serena_pin="$(node -p 'JSON.parse(require("fs").readFileSync("upstreams.lock.json","utf8")).upstreams.serena.version')"
uv tool install --force -p 3.13 "serena-agent==${serena_pin}"
"$HOME/.local/bin/serena" init >/dev/null 2>&1 || serena init >/dev/null 2>&1 || true

DO_NOT_TRACK=1 ./node_modules/.bin/codegraph telemetry off >/dev/null 2>&1 || true

node src/cli.js doctor "${TARGET:-$PWD}" || true

if [[ -n "$TARGET" || -n "$GLOBAL" ]]; then
  node src/cli.js install-omp "${TARGET:-$PWD}" ${GLOBAL}
  echo "No index init is required: lazy-intel creates and maintains indexes automatically."
  echo "In OMP: /mcp reload && /mcp test lazy-intel"
else
  echo "lazy-intel installed. Pass a project root (or --global) to also write OMP MCP configuration."
fi
