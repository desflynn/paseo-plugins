// Resolves the Paseo workspace id for one agent from its on-disk agent record,
// so CLI runs can scope their dashboard reads and writes to one workspace. The
// daemon RPC leg is a logged follow-up; this file is the on-disk resolver.
//
// Every miss degrades to undefined (unscoped): the run stays visible under All
// and never claims another workspace's id. This never throws — a broken home
// directory must not take a CLI call down with it.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveWorkspaceId(agentId: string, home?: string): string | undefined {
  try {
    if (typeof agentId !== "string" || agentId.length === 0) return undefined;
    // PASEO_HOME moves the whole Paseo home (tests use it); an explicit
    // argument wins over the environment.
    const base = home || process.env.PASEO_HOME || join(homedir(), ".paseo");
    const agentsDir = join(base, "agents");
    const slugs = readdirSync(agentsDir, { withFileTypes: true });
    let found: string | undefined;
    for (const entry of slugs) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = readFileSync(join(agentsDir, entry.name, `${agentId}.json`), "utf8");
        const record = JSON.parse(raw) as { workspaceId?: unknown; archivedAt?: unknown };
        if (record.archivedAt) continue; // an archived record is not the agent's live workspace
        if (typeof record.workspaceId !== "string" || record.workspaceId.length === 0) continue;
        if (found !== undefined && found !== record.workspaceId) return undefined; // live records disagree: never guess
        found = record.workspaceId;
      } catch {
        // no record here, unreadable bytes, or bad JSON: miss in this folder, keep looking
      }
    }
    return found;
  } catch {
    return undefined; // no agents folder, unreadable home, anything else: unscoped
  }
}
