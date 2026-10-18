#!/usr/bin/env bash
# Paseo worktree setup (paseo.json worktree.setup). Runs once in a new
# worktree, with the worktree as cwd. Gives the tree the repo's own
# dependencies, the gitignored agent config from the main checkout, and Pi
# trust for this path, so agent seats work here while main stays untouched.
set -euo pipefail

root="${PASEO_WORKTREE_PATH:-$PWD}"
src="${PASEO_SOURCE_CHECKOUT_PATH:-}"
cd "$root"

# 1 deps: the repo's own install, by lockfile
if [ -f package-lock.json ]; then
  npm ci
elif [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then
  yarn install --frozen-lockfile
elif [ -f uv.lock ] && command -v uv >/dev/null 2>&1; then
  uv sync
elif [ -f pyproject.toml ] && command -v uv >/dev/null 2>&1; then
  uv sync
fi

# 2 ignored config: what .gitignore hides and the agents need, from the main checkout
if [ -n "$src" ] && [ -d "$src" ]; then
  if [ -f "$src/.mcp.json" ] && [ ! -e "$root/.mcp.json" ]; then
    cp "$src/.mcp.json" "$root/.mcp.json"
  fi
  for f in "$src"/.env*; do
    if [ -f "$f" ] && [ ! -e "$root/$(basename "$f")" ]; then
      cp "$f" "$root/$(basename "$f")"
    fi
  done
  if [ -d "$src/.pi" ] && [ ! -e "$root/.pi" ]; then
    cp -R "$src/.pi" "$root/.pi"
  fi
  if [ -f "$src/.claude/settings.local.json" ] && [ ! -e "$root/.claude/settings.local.json" ]; then
    if ! grep -q "$src" "$src/.claude/settings.local.json"; then
      mkdir -p "$root/.claude"
      cp "$src/.claude/settings.local.json" "$root/.claude/settings.local.json"
    fi
  fi
fi

# 3 Pi trust: Pi skips project extensions in a path it does not trust
python3 - "$root" <<'PY'
import json
import sys
from pathlib import Path

trust_path = Path.home() / '.pi' / 'agent' / 'trust.json'
trust_path.parent.mkdir(parents=True, exist_ok=True)
trust = json.loads(trust_path.read_text()) if trust_path.exists() else {}
if not isinstance(trust, dict):
    raise SystemExit(f'ERROR: {trust_path} must contain a JSON object')
trust[str(Path(sys.argv[1]).resolve())] = True
trust_path.write_text(json.dumps(dict(sorted(trust.items())), indent=2) + '\n')
print(f'Pi project trust enabled for {Path(sys.argv[1]).resolve()}')
PY
