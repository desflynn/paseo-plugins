// The Paseo agent registry (o20): agent id → workspaceId, read from the
// Paseo home's `agents/` folder — one level of group folders whose files are
// named `<agent id>.json` and carry `workspaceId`, plus any flat files directly
// under `agents/`. The fold's workspace-first attribution resolves an event's
// `by` through `agentWorkspaces(defaultPaseoHome())`.
//
// It looks agents up one at a time. The board only names a few dozen agents,
// while the registry holds every agent ever launched (11,000+ files), so
// reading it whole on a timer froze the panel for seconds (o24).
// Best effort by design: an unreadable folder or bad file is just a miss.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The Paseo home the registry reads from: `$PASEO_HOME`, else `~/.paseo`.
export function defaultPaseoHome(env: { PASEO_HOME?: string } = process.env): string {
  return env.PASEO_HOME || join(homedir(), ".paseo");
}

// How long an agent with no file yet is left alone before it is looked for again.
const MISS_RETRY_MS = 30_000;
// What an agent id looks like in a file name; anything else is not looked up.
const AGENT_FILE_ID = /^[\w-]+$/;

// A found agent never moves workspaces, so it is remembered for good. A missing
// one is retried after MISS_RETRY_MS (its file may not exist yet).
export function agentWorkspaces(paseoHome: string, now: () => number = Date.now): { get(agentId: string): string | undefined } {
  const agentsDir = join(paseoHome, "agents");
  const found = new Map<string, string>();
  const missedAt = new Map<string, number>();

  const workspaceIn = (file: string): string | undefined => {
    if (!existsSync(file)) return undefined;
    try {
      const { workspaceId } = JSON.parse(readFileSync(file, "utf8")) as { workspaceId?: unknown };
      return typeof workspaceId === "string" ? workspaceId : undefined;
    } catch {
      return undefined;
    }
  };
  const lookup = (agentId: string): string | undefined => {
    const name = `${agentId}.json`;
    const flat = workspaceIn(join(agentsDir, name));
    if (flat !== undefined) return flat;
    let groups: string[];
    try {
      groups = readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return undefined;
    }
    for (const group of groups) {
      const workspace = workspaceIn(join(agentsDir, group, name));
      if (workspace !== undefined) return workspace;
    }
    return undefined;
  };

  return {
    get(agentId) {
      const known = found.get(agentId);
      if (known !== undefined) return known;
      if (!AGENT_FILE_ID.test(agentId)) return undefined;
      const missed = missedAt.get(agentId);
      if (missed !== undefined && now() - missed < MISS_RETRY_MS) return undefined;
      const workspace = lookup(agentId);
      if (workspace === undefined) {
        missedAt.set(agentId, now());
        return undefined;
      }
      found.set(agentId, workspace);
      missedAt.delete(agentId);
      return workspace;
    },
  };
}
