# Paseo plugins

Plugin API. Before changing a contribution, the client/server split, an RPC, the manifest, or install/reload, verify capabilities in the installed Paseo implementation first. Get the installed version with `paseo --version`; if `paseo` isn't on `PATH`, use `/Applications/Paseo.app/Contents/Resources/bin/paseo`. Trace behavior in the local source checkout at `~/github/repos/paseo`. That checkout is often behind, so read the installed version's tag (`git show v<version>:<path>`, after `git fetch --tags`) instead of the working tree. Then use https://paseo.sh/docs/plugins as a second confirmation; it documents the latest release. If source or docs disagree with the installed implementation, target the installed behavior and call out the mismatch.

To try a change in Paseo, run `npm install` (once per checkout) and then `npm run dev` in the plugin directory. This makes Paseo run the plugin from your directory, so when you finish in a worktree, run `npm install && npm run dev` in the same plugin under `~/github/paseo-plugins` to switch it back. Confirm with `paseo plugin ls`. Never edit plugin paths in config.json or restart the daemon.

## Worktrees

This repo runs its own Paseo worktrees. `paseo.json` runs `scripts/worktree-setup.sh` in each new tree: the repo's own dependencies, the gitignored agent config from the main checkout, and Pi trust for the new path. The worktree leaves main untouched.

```yaml
WORKTREE:
  - bad: a tracked link or config entry points at /Users/des/... or at another checkout
    good: relative links inside the repo, or a bare dci-* command on PATH
  - bad: you call a worktree ready because setup exited 0
    good: fork a throwaway worktree, run setup, and check every path resolves inside it
```

### What the setup script does

1. deps: the repo's own install, by lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, or `uv sync`).
2. ignored config: copies from `$PASEO_SOURCE_CHECKOUT_PATH` what `.gitignore` hides and the agents need: `.mcp.json`, `.pi/`, `.env*`; `.claude/settings.local.json` only when it holds no path into the main checkout.
3. Pi trust: merges the worktree path into `~/.pi/agent/trust.json` as `{"<absolute path>": true}`; Pi skips project extensions in an untrusted path.

Tracked config must hold: relative links into `.agents/`, hook commands as `$CLAUDE_PROJECT_DIR` paths or a bare `dci-*` on PATH, no `/Users` path and no flight-plan server.

Proof after a change: fork a throwaway worktree, run setup, start the worktree's own dci MCP, call `dci_prep`, and check `git status` is clean.
