// The Paseo agent registry (o20): agent id → workspaceId, read from the
// Paseo home's `agents/` folder — one level of group folders whose files each
// carry `id` and `workspaceId`, plus any flat files directly under `agents/`.
// Best effort by design: one unreadable group or bad file hides no registry.
// The fold's workspace-first attribution resolves an event's `by` through
// this map, so the server passes `agentWorkspaceMap(defaultPaseoHome())`.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The Paseo home the registry reads from: `$PASEO_HOME`, else `~/.paseo`.
export function defaultPaseoHome(env: { PASEO_HOME?: string } = process.env): string {
  return env.PASEO_HOME || join(homedir(), ".paseo");
}

// Every resolvable agent in the registry, keyed by its `id`.
export function agentWorkspaceMap(paseoHome: string): Map<string, string> {
  const map = new Map<string, string>();
  const agentsDir = join(paseoHome, "agents");
  const entries = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const read = (file: string) => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown; workspaceId?: unknown };
      if (typeof parsed.id === "string" && typeof parsed.workspaceId === "string") {
        map.set(parsed.id, parsed.workspaceId);
      }
    } catch {
      // One bad file hides no registry.
    }
  };
  for (const entry of entries(agentsDir)) {
    if (entry.isFile() && entry.name.endsWith(".json")) read(join(agentsDir, entry.name));
    if (!entry.isDirectory()) continue;
    const group = join(agentsDir, entry.name);
    for (const file of entries(group)) {
      if (file.isFile() && file.name.endsWith(".json")) read(join(group, file.name));
    }
  }
  return map;
}
