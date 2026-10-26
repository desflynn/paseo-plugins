// One JSON doc with every workspace's board on this host (Des's ask, relayed
// by PSR Guy): the Progress page's global dashboard reads it over ssh. The
// fold is the plugin's own — findStore resolves the store, readProgress
// builds the Dashboard the panel builds, summariseBoard shrinks it — so this
// doc can never disagree with the panel. Read-only: no locks, no markers, no
// store creation; a workspace whose store has no board is skipped.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summariseBoard, type BoardSummary } from "../shared/overview.ts";
import { findStore } from "./store.ts";
import { readProgress } from "./progress-file.ts";

/** What the workspace list yields per workspace. */
export interface WorkspaceEntry {
  workspaceId: string;
  title?: string;
  project?: string;
  name?: string;
  cwd: string;
}

export interface BoardEntry {
  cwd: string;
  title: string;
  directory: string;
  summary: BoardSummary;
}

export interface BoardsDoc {
  machine: string;
  at: string;
  boards: BoardEntry[];
  /** Why the host shows no boards, set only when the workspace list itself came up empty. */
  note?: string;
}

/** The workspace list plus, when it is empty, the one reason why. */
export interface WorkspaceListing {
  workspaces: WorkspaceEntry[];
  reason?: string;
}

/** The two places a host's workspaces can come from, both stubbable in tests. */
export interface WorkspaceSources {
  rpc: () => WorkspaceEntry[] | undefined;
  registry: () => WorkspaceEntry[] | undefined | Promise<WorkspaceEntry[] | undefined>;
}

function toEntry(candidate: unknown): WorkspaceEntry | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || typeof record.cwd !== "string") return null;
  if (record.archivedAt !== null && record.archivedAt !== undefined) return null;
  return {
    workspaceId: record.workspaceId,
    title: typeof record.title === "string" ? record.title : undefined,
    project: typeof record.project === "string" ? record.project : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
    cwd: record.cwd,
  };
}

/** The daemon's own registry: the fast path, read straight off the disk. */
export async function listWorkspacesFromRegistry(
  home = homedir(),
  registryPath?: string,
): Promise<WorkspaceEntry[] | undefined> {
  const path = registryPath ??
    join(process.env.PASEO_HOME ?? join(home, ".paseo"), "projects", "workspaces.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const entries = parsed.map(toEntry).filter((entry): entry is WorkspaceEntry => entry !== null);
    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined; // unreadable registry: the CLI RPC decides
  }
}

/** The host's workspaces from its own local daemon; undefined when unreachable. */
export function listWorkspacesRpc(cli = "paseo"): WorkspaceEntry[] | undefined {
  const run = spawnSync(cli, ["workspace", "ls", "--json"], { encoding: "utf8" });
  if (run.error || run.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.map(toEntry).filter((entry): entry is WorkspaceEntry => entry !== null);
  } catch {
    return undefined;
  }
}

/**
 * The host's workspaces, the daemon's RPC first (authoritative on any host,
 * whatever the cwd) with the registry file as the fallback. When both come up
 * short, the reason says why, so an empty host is never mistaken for a dead one.
 */
export async function resolveWorkspaces(
  home: string = homedir(),
  sources: Partial<WorkspaceSources> = {},
): Promise<WorkspaceListing> {
  const rpc = sources.rpc ?? (() => listWorkspacesRpc());
  const registry = sources.registry ?? (() => listWorkspacesFromRegistry(home));
  const rpcEntries = rpc();
  if (rpcEntries && rpcEntries.length > 0) return { workspaces: rpcEntries };
  const registryEntries = await registry();
  if (registryEntries && registryEntries.length > 0) return { workspaces: registryEntries };
  return {
    workspaces: [],
    reason: rpcEntries ? "both empty" : "rpc failed, registry unreadable",
  };
}

/** The one doc: every workspace that has a board, folded through the panel's own path. */
export async function boardsDocument(
  home: string = homedir(),
  list: () =>
    | WorkspaceEntry[]
    | WorkspaceListing
    | undefined
    | Promise<WorkspaceEntry[] | WorkspaceListing | undefined> = () => resolveWorkspaces(home),
  now: () => Date = () => new Date(),
): Promise<BoardsDoc> {
  const doc: BoardsDoc = { machine: hostname(), at: now().toISOString(), boards: [] };
  const listed = await list();
  const workspaces = Array.isArray(listed) ? listed : listed?.workspaces ?? [];
  if (!Array.isArray(listed) && listed?.reason && workspaces.length === 0) {
    doc.note = `no workspaces: ${listed.reason}`;
  }
  const entries = await Promise.all(
    workspaces.map(async (workspace): Promise<BoardEntry | null> => {
      // findStore is the one place that knows the store key (o65 keeps it that
      // way). Never hash here; never cache the resolved directory.
      let store;
      try {
        store = await findStore(workspace.cwd, home);
      } catch {
        return null; // an unreadable workspace never blocks the rest of the host
      }
      // No store on disk means no board: skip. Never create one.
      const read = await readProgress(store.directory, now());
      if (!read.configured) return null;
      const summary = summariseBoard(read.dashboard);
      if (!summary) return null;
      return {
        cwd: workspace.cwd,
        title: workspace.title ??
          (workspace.project && workspace.name ? `${workspace.project}/${workspace.name}` : workspace.cwd),
        directory: store.directory,
        summary,
      };
    }),
  );
  doc.boards = entries.filter((entry): entry is BoardEntry => entry !== null);
  return doc;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  boardsDocument().then(
    (doc) => { console.log(JSON.stringify(doc)); },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
