#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=""
GLOBAL=0
for arg in "$@"; do
  case "$arg" in
    --global) GLOBAL=1 ;;
    --*) echo "unknown option: $arg" >&2; exit 2 ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "install.sh accepts at most one project root" >&2
        exit 2
      fi
      TARGET="$arg"
      ;;
  esac
done

# Refuse an unsupported runtime before touching any dependency or OMP state.
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
node_minor="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || true)"
if [[ -z "$node_major" ]] || (( node_major < 22 )) || (( node_major >= 25 )) || { (( node_major == 22 )) && (( node_minor < 5 )); }; then
  echo "lazy-intel requires Node >=22.5 and <25; found ${node_major:-none}.${node_minor:-0}" >&2
  echo "Select a supported runtime first, e.g.:" >&2
  echo "  PATH=\"\$(brew --prefix node@22)/bin:\$PATH\" ./scripts/install.sh [project-root] [--global]" >&2
  exit 1
fi

command -v npm >/dev/null 2>&1 || { echo "npm is required; use the npm bundled with the supported Node runtime" >&2; exit 1; }
command -v uv >/dev/null 2>&1 || {
  echo "uv is required to create the project-local semantic environment" >&2
  echo "Install uv for your user, then rerun; lazy-intel will not mutate Homebrew or global uv tools." >&2
  exit 1
}

# The root package is private. Runtime setup builds only the owned forks, core,
# and workers; published CLI products remain development-only fixture inputs.
node scripts/build-unified.mjs

# Confirm the installed entrypoint without indexing or starting any daemon.
node src/cli.js --version

if [[ -n "$TARGET" || "$GLOBAL" == 1 ]]; then
  OMP_ARGS=("${TARGET:-$PWD}")
  if [[ "$GLOBAL" == 1 ]]; then OMP_ARGS+=(--global); fi
  node src/cli.js install-omp "${OMP_ARGS[@]}"
  echo "No index init is required: lazy-intel creates and maintains indexes automatically."
  echo "In OMP: /mcp reload && /mcp test lazy-intel"
else
  echo "lazy-intel installed. Pass a project root (or --global) to also write OMP MCP configuration."
fi
