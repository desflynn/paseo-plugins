import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Dashboard } from "./dashboard.ts";
import { BOARD_MODES } from "./modes.ts";
import type { BoardSummary } from "./overview.ts";

// `panelOpened`: the Progress panel has been opened for this worktree before.
// `root`: the worktree root the file was read from, which stored paths are
// relative to. It can sit above the workspace directory.
// `file`: where the progress file is, for people. `savedTo`: the repo folder
// each run is saved to, or null when history stays on this computer.
// `inRepo`: saving history needs a git repo to keep the choice in.
// `version` changes whenever anything else in the result does.
export type DashboardResult = {
  configured: boolean; dashboard: Dashboard; panelOpened: boolean; file: string; savedTo: string | null; inRepo: boolean; root: string; version: string;
};

export const getDashboard = defineRpc({
  name: "progress.get",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    // The version the caller already has; if it's current, the reply is `unchanged`.
    since: z.string().optional(),
    // "workspace" (the default) folds this workspace's run; "all" folds the
    // whole file exactly like 0.4.0.
    scope: z.enum(["workspace", "all"]).optional(),
  }),
  output: z.custom<DashboardResult | { unchanged: true; version: string }>(),
});

// What a message-box pill shows: counts that need the user, and whether a run
// is open in a worktree whose panel has never been opened.
export type AttentionResult = { configured: boolean; questions: number; stuck: number; runOpen: boolean; panelOpened: boolean };

export const getAttention = defineRpc({
  name: "progress.attention",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
  }),
  output: z.custom<AttentionResult>(),
});

// o36: the Progress page. One call folds each listed workspace's own board to
// its summary, null where a workspace has no board.
export const getOverview = defineRpc({
  name: "progress.overview",
  input: z.object({
    workspaces: z.array(z.object({ workspaceId: z.string().min(1), workspaceDirectory: z.string().min(1) })),
  }),
  output: z.custom<{ boards: Record<string, BoardSummary | null>; hostColors?: Record<string, string> }>(),
});

// Everything view (o1): every configured host's boards in one call. The client
// supplies the hosts it knows from Paseo; the server reads each one and falls
// back to its cache when a host cannot be reached, so an offline box still
// renders with its last good boards.
const hostSnapshotShape = z.object({
  serverId: z.string().min(1),
  label: z.string().min(1),
  status: z.string(),
  boards: z.custom<Record<string, BoardSummary | null>>(),
  at: z.string(),
  stale: z.boolean(),
});
export const getAllHostsOverview = defineRpc({
  name: "progress.overview.all",
  input: z.object({
    hosts: z.array(z.object({ serverId: z.string().min(1), label: z.string().min(1), status: z.string() })),
  }),
  output: z.object({ hosts: z.array(hostSnapshotShape) }),
});

// Records that the Progress panel was opened, so the "Progress" pill goes away for good.
export const markPanelOpened = defineRpc({
  name: "progress.panel.opened",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
  }),
  output: z.object({}),
});

// The panel's freeze evidence (o24): lines for the server's perf log.
export const reportPerf = defineRpc({
  name: "progress.perf.report",
  input: z.object({ lines: z.array(z.string().max(2000)).max(50) }),
  output: z.object({}),
});

// The `paseo-progress` launcher on the daemon host. "foreign" means another
// file already sits at that path; the plugin leaves it alone.
const launcherStatus = z.object({
  path: z.string(),
  state: z.enum(["missing", "current", "outdated", "foreign"]),
  onPath: z.boolean(),
});
export type LauncherStatus = z.infer<typeof launcherStatus>;

export const getLauncherStatus = defineRpc({
  name: "progress.launcher.status",
  input: z.object({}),
  output: launcherStatus,
});

export const installLauncher = defineRpc({
  name: "progress.launcher.install",
  input: z.object({}),
  output: launcherStatus,
});

// The paseo-progress skill, linked into each agent's skills folder.
const skillState = z.enum(["missing", "current", "outdated", "foreign"]);
const skillStatus = z.object({
  state: skillState,
  targets: z.array(z.object({ path: z.string(), state: skillState })),
});
export type SkillStatus = z.infer<typeof skillStatus>;

export const getSkillStatus = defineRpc({
  name: "progress.skill.status",
  input: z.object({}),
  output: skillStatus,
});

export const installSkill = defineRpc({
  name: "progress.skill.install",
  input: z.object({}),
  output: skillStatus,
});

// The folders inside one folder of the worktree ("" is the top), for the
// folder picker.
export const listFolders = defineRpc({
  name: "progress.folders.list",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    folder: z.string(),
  }),
  output: z.object({ folder: z.string(), folders: z.array(z.string()) }),
});

// Starts saving each run to a folder in the repo (relative to the worktree
// root), for every worktree of the repo, or stops when `folder` is null.
export const setHistoryFolder = defineRpc({
  name: "progress.history.set",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    folder: z.string().nullable(),
  }),
  output: z.object({ savedTo: z.string().nullable() }),
});

// o38: sets a board's state from the Progress page. A hold is written to the
// board; a change to the seat's full auto goes to `agentId` as a prompt.
export const setBoardMode = defineRpc({
  name: "progress.mode.set",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    mode: z.enum(BOARD_MODES),
    agentId: z.string().min(1).optional(),
  }),
  output: z.object({ mode: z.enum(BOARD_MODES), pinged: z.boolean(), error: z.string().optional() }),
});

// Opens a recorded local deliverable on the daemon host with its default app.
export const openDeliverable = defineRpc({
  name: "progress.deliverable.open",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    // A deliverable ("D3") or a question attachment ("Q7.2").
    ref: z.string().min(1),
  }),
  output: z.object({ opened: z.string() }),
});

// An image or text file's contents, for the preview dialog.
export const previewDeliverable = defineRpc({
  name: "progress.deliverable.preview",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    // A deliverable ("D3") or a question attachment ("Q7.2").
    ref: z.string().min(1),
  }),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("image"), dataUri: z.string(), bytes: z.number() }),
    z.object({ kind: z.literal("text"), text: z.string(), bytes: z.number(), truncated: z.boolean() }),
  ]),
});

// One row of the Beads tab: what `bd list --json` prints, narrowed to the
// fields the tab shows. Beads stays the record; the panel shows a read-only
// view of it. Only `id`, `title` and `status` are guaranteed.
const beadIssue = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.number().optional(),
  issue_type: z.string().optional(),
  updated_at: z.string().optional(),
  // Carried since O2600 so the panel's done-sink can split done from skipped.
  close_reason: z.string().optional(),
  // Carried since O3000 (o30): the epic a bead hangs under — bd emits it on
  // children; absent on top-level beads. The panel nests children under it.
  parent: z.string().optional(),
});
export type BeadIssue = z.infer<typeof beadIssue>;

// The beads method's return shape. It lives here, in shared, so the client
// bundle can import it without touching any server-only module; the Paseo
// bundler refuses even type-only imports from the server side.
export type BeadsResult =
  | { state: "ok"; issues: BeadIssue[] }
  | { state: "none" }
  | { state: "error"; message: string };

// The repo's recorded beads for the read-only Beads tab. "none" when there is
// no beads database to read; "error" carries what went wrong.
export const getBeads = defineRpc({
  name: "progress.beads",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
  }),
  output: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ok"), issues: z.array(beadIssue) }),
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("error"), message: z.string() }),
  ]),
});

// ── The bead detail sheet (T13 / O2200) ───────────────────────────────
// One bead's full record for the sheet opened from the Beads tab, and the
// two writes the sheet offers. Status writes go through bd's own verbs
// (close --reason closes; update --status moves the rest); the upgrade
// promotes the bead through the existing ticket-add path with --ref
// bead:<id>. Beads stays the record; nothing here invents a third store.
const beadStatus = z.enum(["open", "in_progress", "blocked", "deferred", "closed"]);
export type BeadStatus = z.infer<typeof beadStatus>;

// The full record `bd show --json` prints, narrowed to the fields the sheet
// shows. Everything past the tab's row fields is optional.
export type BeadDetail = BeadIssue & {
  description?: string;
  owner?: string;
  created_at?: string;
  created_by?: string;
  closed_at?: string;
  close_reason?: string;
};

export type BeadDetailResult =
  | { state: "ok"; bead: BeadDetail }
  | { state: "none" }
  | { state: "error"; message: string };

export const getBeadDetail = defineRpc({
  name: "progress.beads.detail",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    id: z.string().min(1),
  }),
  output: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ok"), bead: z.custom<BeadDetail>() }),
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("error"), message: z.string() }),
  ]),
});

export const setBeadStatus = defineRpc({
  name: "progress.beads.status",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    id: z.string().min(1),
    status: beadStatus,
    // Carried to `bd close --reason`; ignored for the other statuses.
    reason: z.string().optional(),
  }),
  output: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ok") }),
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("error"), message: z.string() }),
  ]),
});

export const upgradeBead = defineRpc({
  name: "progress.beads.upgrade",
  input: z.object({
    workspaceId: z.string().min(1),
    workspaceDirectory: z.string().min(1),
    id: z.string().min(1),
  }),
  output: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ok"), ticketId: z.string().nullable() }),
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("error"), message: z.string() }),
  ]),
});
