import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { boardStatuses, objectiveFeed, owedStuck, type Dashboard, type Ticket, type StuckItem } from "../shared/dashboard.ts";
import { UNION_SCOPE } from "../shared/dashboard.ts";
import { PROGRESS_FILE_NAME } from "../shared/events.ts";
import { type BoardMode, planModeChange } from "../shared/modes.ts";
import { type BoardSummary, summaryOf, withFeed } from "../shared/overview.ts";import { runCli } from "./cli.ts";
import type { AttentionResult, DashboardResult } from "../shared/rpc.ts";
import { markPanelOpened, readProgress } from "./progress-file.ts";
import { findRoot } from "./paths.ts";
import { findStore, historyFolder, inGitRepo, listFolders, setHistoryFolder } from "./store.ts";

const versions = new WeakMap<Dashboard, { key: string; version: string }>();

export async function handleMarkPanelOpened(
  input: { workspaceId: string; workspaceDirectory: string },
  _context: PluginHandlerContext,
) {
  await markPanelOpened((await findStore(findRoot(input.workspaceDirectory))).directory);
  return {};
}

// The panel polls with the version it already has; when nothing it shows has
// changed, the reply is just "unchanged" instead of the whole dashboard again.
export async function handleGetDashboard(
  input: { workspaceId: string; workspaceDirectory: string; since?: string; scope?: "workspace" | "all" },
  _context: PluginHandlerContext,
): Promise<DashboardResult | { unchanged: true; version: string }> {
  const root = findRoot(input.workspaceDirectory);
  const store = await findStore(root);
  // "workspace" (the default) folds just this workspace's run; "all" folds
  // every scope's current run together into one board (owner union).
  const result = await readProgress(store.directory, undefined, input.scope === "all" ? UNION_SCOPE : input.workspaceId);
  const file = join(store.shown, PROGRESS_FILE_NAME);
  const savedTo = await historyFolder(root);
  const inRepo = await inGitRepo(root);
  // Scope sits in the key so a scope switch is never answered "unchanged"
  // with the other scope's version.
  const key = JSON.stringify([result.panelOpened, file, savedTo, inRepo, input.scope ?? "workspace"]);
  let cached = versions.get(result.dashboard);
  if (!cached || cached.key !== key) {
    cached = { key, version: createHash("sha1").update(JSON.stringify(result) + key).digest("base64url") };
    versions.set(result.dashboard, cached);
  }
  const { version } = cached;
  return input.since === version ? { unchanged: true, version } : { ...result, file, savedTo, inRepo, root, version };
}

// o36: each workspace's own board as a summary. A workspace whose store cannot
// be read has no board here, and never fails the rest.
export async function handleGetOverview(
  input: { workspaces: { workspaceId: string; workspaceDirectory: string }[] },
  _context: PluginHandlerContext,
): Promise<{ boards: Record<string, BoardSummary | null> }> {
  const boards: Record<string, BoardSummary | null> = {};
  for (const { workspaceId, workspaceDirectory } of input.workspaces) {
    try {
      const { configured, dashboard } = await readProgress((await findStore(findRoot(workspaceDirectory))).directory, undefined, workspaceId);
      boards[workspaceId] = configured ? withFeed(summaryOf(dashboard), dashboard) : null;
    } catch {
      boards[workspaceId] = null;
    }
  }
  return { boards };
}

// o38: the Progress page sets a board's state. A hold is written to the board
// here; the seat's full auto is the seat's own (it renames itself and files
// its wakes), so a change to it goes to the owner seat as a prompt. A failed
// ping never undoes the board change: it is reported back for the page to show.
export async function handleSetBoardMode(
  input: { workspaceId: string; workspaceDirectory: string; mode: BoardMode; agentId?: string },
  context: PluginHandlerContext,
): Promise<{ mode: BoardMode; pinged: boolean; error?: string }> {
  const { workspaceId, workspaceDirectory, mode, agentId } = input;
  const { dashboard } = await readProgress((await findStore(findRoot(workspaceDirectory))).directory, undefined, workspaceId);
  const plan = planModeChange(dashboard, mode);
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await runCli(argv, { cwd: workspaceDirectory, workspaceId, out: (line) => lines.push(line) });
    if (code !== 0) throw new Error(lines.join(" ") || `paseo-progress ${argv.join(" ")} failed`);
  };
  if (plan.hold === "clear") await run("hold", "clear");
  else if (plan.hold !== "none") await run("hold", "set", "--kind", plan.hold.kind);
  if (!plan.ping) return { mode, pinged: false };
  if (!agentId) return { mode, pinged: false, error: "No agent to tell." };
  try {
    await context.paseo.agents.ref(agentId).send(plan.ping);
    return { mode, pinged: true };
  } catch (error) {
    return { mode, pinged: false, error: `Could not tell the agent: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Just what a message-box pill needs, so polling every workspace stays small.
export async function handleGetAttention(
  input: { workspaceId: string; workspaceDirectory: string },
  _context: PluginHandlerContext,
): Promise<AttentionResult> {
  // The pill counts this workspace's run; legacy unscoped events stay visible.
  const { configured, dashboard, panelOpened } = await readProgress((await findStore(findRoot(input.workspaceDirectory))).directory, undefined, input.workspaceId);
  return {
    configured,
    questions: dashboard.questions.open.length,
    stuck: owedStuck(dashboard.stuck, dashboard.tickets).length,
    runOpen: Boolean(dashboard.run && !dashboard.run.finished),
    panelOpened,
  };
}

export async function handleListFolders(
  input: { workspaceId: string; workspaceDirectory: string; folder: string },
  _context: PluginHandlerContext,
) {
  return listFolders(findRoot(input.workspaceDirectory), input.folder);
}

// Runs only when the user picks a folder, or stops saving, in the panel.
export async function handleSetHistoryFolder(
  input: { workspaceId: string; workspaceDirectory: string; folder: string | null },
  _context: PluginHandlerContext,
) {
  return { savedTo: await setHistoryFolder(findRoot(input.workspaceDirectory), input.folder) };
}
