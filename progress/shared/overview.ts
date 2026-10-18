// o36: the Progress page. One board folds to a small summary; every
// workspace's summary and live agents then group by project. Pure, so the
// page glue stays thin and the rules sit under test.
import { boardStatuses, displayId, displayPriority, indicatorLabel, isAutoPullable, sortObjectives, ticketDepth, type Conn, type Dashboard, type Hold, type Indicator } from "./dashboard.ts";
import { BOARD_MODES, MODE_LABEL, type BoardMode } from "./modes.ts";

// What the Progress page needs of one board. Open and in progress counts by
// priority leave the finished work out; "lower" is P3 and below, and no
// priority at all.
export interface PriorityCounts { p0: number; p1: number; p2: number; lower: number }
export interface ReadyItem { id: string; title: string; priority: number; auto: boolean; depth: number; working: boolean }
export interface NowItem { id: string; title: string; stage?: string; since: string; more: number }

export interface BoardSummary {
  title: string | null;
  open: number;
  inProgress: number;
  done: number;
  statuses: Indicator[];
  // Estimated minutes, the board's own measure (skipped work is left out).
  percent: number;
  doneMin: number;
  totalMin: number;
  inProgressMin: number;
  priorities: PriorityCounts;
  // Open or in progress P0 to P2: what full auto would pull.
  autoCount: number;
  // The objective being worked, or null when none is.
  now: NowItem | null;
  // Open objectives, the order the board lists them.
  ready: ReadyItem[];
  conn?: Conn;
  hold?: Hold;
}

// A workspace has no board until it has a run. The summary reads the board
// alone, so a stale board with a working agent still reads Stale here.
export function summariseBoard(dashboard: Dashboard): BoardSummary | null {
  if (!dashboard.run) return null;
  const { tickets } = dashboard;
  const count = (status: string) => tickets.filter((ticket) => ticket.status === status).length;
  const inProgress = count("in_progress");
  const done = count("closed");
  const unfinished = tickets.filter((ticket) => ticket.status !== "closed");
  const priorities: PriorityCounts = { p0: 0, p1: 0, p2: 0, lower: 0 };
  for (const ticket of unfinished) {
    if (ticket.priority === 0) priorities.p0++;
    else if (ticket.priority === 1) priorities.p1++;
    else if (ticket.priority === 2) priorities.p2++;
    else priorities.lower++;
  }
  const sorted = sortObjectives(tickets);
  const working = sorted.filter((ticket) => ticket.status === "in_progress");
  const first = working[0];
  return {
    title: dashboard.run.title,
    open: tickets.length - inProgress - done,
    inProgress,
    done,
    statuses: boardStatuses(dashboard, false),
    percent: dashboard.progress.percent,
    doneMin: dashboard.progress.doneMin,
    totalMin: dashboard.progress.totalMin,
    inProgressMin: working.reduce((sum, ticket) => sum + ticket.estimateMin, 0),
    priorities,
    autoCount: tickets.filter(isAutoPullable).length,
    now: first ? { id: displayId(first.id), title: first.title, ...(first.stage ? { stage: first.stage } : {}), since: first.statusSince, more: working.length - 1 } : null,
    ready: sorted.filter((ticket) => ticket.status !== "closed")
      .map((ticket) => ({ id: displayId(ticket.id), title: ticket.title, priority: displayPriority(ticket), auto: isAutoPullable(ticket), depth: ticketDepth(ticket, tickets), working: ticket.status === "in_progress" })),
    ...(dashboard.conn ? { conn: dashboard.conn } : {}),
    ...(dashboard.hold ? { hold: dashboard.hold } : {}),
  };
}

// The Progress page asks for every board on every poll (3 s). A summary costs a
// sort and several passes over the objectives, and a dashboard object is
// replaced only when its file or a validity window changes, so keep the summary
// beside it: an unchanged board costs a WeakMap hit instead of 0.9 ms.
const summaries = new WeakMap<Dashboard, BoardSummary | null>();
export function summaryOf(dashboard: Dashboard): BoardSummary | null {
  if (!summaries.has(dashboard)) summaries.set(dashboard, summariseBoard(dashboard));
  return summaries.get(dashboard) ?? null;
}

export interface WorkspaceRef {
  id: string;
  projectId: string;
  projectName: string;
  projectPath?: string;
  name: string;
  directory: string;
  // The workspace's own labels in Paseo; BRO marks Top (Zoe, Joey).
  labels?: string[];
}

export interface AgentRef {
  id: string;
  workspaceId: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  title: string | null;
  parentAgentId: string | null;
}

export interface WorkspaceEntry {
  workspace: WorkspaceRef;
  board: BoardSummary | null;
  agents: AgentRef[];
}

export interface ProjectGroup {
  projectId: string;
  projectName: string;
  projectPath?: string;
  workspaces: WorkspaceEntry[];
  // active counts in-progress work, stale included; stuck counts flagged work.
  totals: { boards: number; fullAutos: number; active: number; stuck: number; agents: number };
}

const AGENT_ORDER: Record<AgentRef["status"], number> = { running: 0, initializing: 1, error: 2, idle: 3, closed: 4 };

const indicatorCount = (board: BoardSummary | null, kinds: Indicator["kind"][]) =>
  board ? board.statuses.reduce((sum, status) => (status.kind !== "idle" && kinds.includes(status.kind) ? sum + status.count : sum), 0) : 0;

// Des, 16-17 Oct: boards go the BRO-labelled workspaces first (Zoe, Joey), then Head Guy, then Ninja,
// then the rest alphabetically. A board's state does not move it, and a name alone is not BRO.
export const isBro = (workspace: WorkspaceRef): boolean => (workspace.labels ?? []).some((label) => label.trim().toLowerCase() === "bro");

export function seatRank(workspace: WorkspaceRef): number {
  if (isBro(workspace)) return 0;
  if (/\bhead\b/i.test(workspace.name)) return 1;
  if (/\bninja\b/i.test(workspace.name)) return 2;
  return 3;
}

// Icons and flags around a name do not count when sorting by it.
const sortName = (name: string) => name.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();

function byBoardOrder(a: WorkspaceEntry, b: WorkspaceEntry): number {
  return seatRank(a.workspace) - seatRank(b.workspace) || sortName(a.workspace.name).localeCompare(sortName(b.workspace.name));
}

export function groupOverview(workspaces: WorkspaceRef[], boards: Record<string, BoardSummary | null>, agents: AgentRef[]): ProjectGroup[] {
  const live = agents.filter((agent) => agent.status !== "closed");
  const groups = new Map<string, ProjectGroup>();
  for (const workspace of workspaces) {
    const board = boards[workspace.id] ?? null;
    const mine = live.filter((agent) => agent.workspaceId === workspace.id).sort((a, b) => AGENT_ORDER[a.status] - AGENT_ORDER[b.status]);
    if (!board && !mine.length) continue;
    let group = groups.get(workspace.projectId);
    if (!group) {
      group = { projectId: workspace.projectId, projectName: workspace.projectName, ...(workspace.projectPath ? { projectPath: workspace.projectPath } : {}), workspaces: [], totals: { boards: 0, fullAutos: 0, active: 0, stuck: 0, agents: 0 } };
      groups.set(workspace.projectId, group);
    }
    group.workspaces.push({ workspace, board, agents: mine });
    group.totals.boards += board ? 1 : 0;
    group.totals.fullAutos += board?.conn ? 1 : 0;
    group.totals.active += indicatorCount(board, ["active", "stale"]);
    group.totals.stuck += indicatorCount(board, ["stuck"]);
    group.totals.agents += mine.length;
  }
  for (const group of groups.values()) {
    group.workspaces.sort(byBoardOrder);
  }
  return [...groups.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
}

// ── o38: the overhaul. The page's rules, pure, so the glue stays thin. ──

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const kindCount = (board: BoardSummary | null, kind: Indicator["kind"]) =>
  board ? board.statuses.reduce((sum, status) => (status.kind === kind && status.kind !== "idle" ? sum + status.count : sum), 0) : 0;

export interface BarSegment { kind: "done" | "progress" | "open"; flex: number; tint?: "warning" | "danger" }

// The progress bar by estimated minutes. Stale work tints the in-progress part,
// stuck work the part still to do. No estimates, no bar.
export function barSegments(board: BoardSummary): BarSegment[] {
  const { doneMin, inProgressMin, totalMin } = board;
  const stale = kindCount(board, "stale") > 0, stuck = kindCount(board, "stuck") > 0;
  const parts: BarSegment[] = [
    { kind: "done", flex: doneMin },
    { kind: "progress", flex: inProgressMin, ...(stale ? { tint: "warning" as const } : {}) },
    { kind: "open", flex: Math.max(0, totalMin - doneMin - inProgressMin), ...(stuck ? { tint: "danger" as const } : {}) },
  ];
  return parts.filter((part) => part.flex > 0);
}

export function priorityChips(board: BoardSummary): { chips: string[]; lower: string | null } {
  const { p0, p1, p2, lower } = board.priorities;
  const chips = ([["P0", p0], ["P1", p1], ["P2", p2]] as const).filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`);
  return { chips, lower: chips.length && lower > 0 ? `+${lower} lower` : null };
}

// What is in progress repeats here, with the queued rows (P0-P2, what full auto pulls); P3, P4 and unset that nobody is working are owner-held, so they fold into one line.
// Expanded, the parked rows show too and the line offers to fold them back.
export function readyRows(board: BoardSummary, expanded = false): { items: ReadyItem[]; total: number; more: string } {
  const items = board.ready.filter((item) => item.auto || item.working);
  const parked = board.ready.length - items.length;
  const more = parked <= 0 ? "" : expanded ? "Show fewer" : `+${parked} more open`;
  return { items: expanded ? board.ready : items, total: board.ready.length, more };
}

// An archived agent can still be opened to chat. It belongs to a repo by the folder it worked in, newest archived first.
export interface ArchivedAgent { id: string; title: string | null; cwd: string; archivedAt: string }

export function archivedFor(group: ProjectGroup, archived: ArchivedAgent[]): ArchivedAgent[] {
  const root = group.projectPath?.replace(/\/+$/, "");
  if (!root) return [];
  return archived.filter((agent) => agent.cwd === root || agent.cwd.startsWith(`${root}/`)).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

// Full auto's infinity and chequered flag show once, in the card header, so the names on the card go without them.
const AUTO_MARKS = /\s*(?:♾️?|\u{1F3C1})(?:\s*(?:♾️?|\u{1F3C1}))*/gu;
export const plainName = (name: string): string => name.replace(AUTO_MARKS, "");

// The owner is already in the card header, so the agent list shows only when the workspace has other agents too.
export function cardAgents(agents: AgentRef[], owner: AgentRef | null): AgentRef[] {
  if (!owner) return agents;
  if (agents.every((agent) => agent.id === owner.id)) return [];
  return [owner, ...agents.filter((agent) => agent.id !== owner.id)];
}

const DOT_ORDER: Record<Indicator["kind"], number> = { stuck: 0, stale: 1, active: 2, idle: 3 };

export function statusDots(statuses: Indicator[]): { kind: Indicator["kind"]; label: string }[] {
  return [...statuses].sort((a, b) => DOT_ORDER[a.kind] - DOT_ORDER[b.kind]).map((status) => ({ kind: status.kind, label: indicatorLabel(status) }));
}

// A chat is a workspace with agents and no board. Nightly Automations is the scheduler's own workspace, not a chat.
const isChat = (entry: WorkspaceEntry) => !entry.board && !/^nightly automations$/i.test(entry.workspace.name.trim());

// The repo's boards, and the workspaces that only have agents.
export function splitGroup(group: ProjectGroup): { boards: WorkspaceEntry[]; chats: WorkspaceEntry[] } {
  return { boards: group.workspaces.filter((entry) => entry.board), chats: group.workspaces.filter(isChat) };
}

export function repoSummary(group: ProjectGroup): string {
  return `${plural(group.totals.boards, "board")} · ${plural(group.totals.agents, "agent")}`;
}

export type SectionId = "top" | "active" | "idle" | "quiet";
export const SECTIONS: Record<SectionId, { title: string; sub: string; foldedByDefault: boolean }> = {
  top: { title: "Top", sub: "BRO boards, while all of them are idle", foldedByDefault: false },
  active: { title: "Active", sub: "A board in the repo is being worked on", foldedByDefault: false },
  idle: { title: "Idle", sub: "Open P0–P2 work, nothing running", foldedByDefault: false },
  quiet: { title: "Quiet", sub: "Paused, stuck, or nothing to pick up", foldedByDefault: true },
};

// Des, 16-17 Oct: a repo with BRO-labelled boards sits in Top while all of them are idle; the moment one is not, the repo is Active, ahead of the rest.
const broBoards = (group: ProjectGroup): BoardSummary[] =>
  group.workspaces.flatMap((entry) => (entry.board && isBro(entry.workspace) ? [entry.board] : []));
const isIdle = (board: BoardSummary) => (["active", "stuck", "stale"] as const).every((kind) => kindCount(board, kind) === 0);

// Des's order, top to bottom: BRO (Zoe, Joey), Head Guy, Ninja, anyone else, then agents without a board.
// A repo ranks by its best board; a repo with only unboarded agents ranks last. Equal ranks keep their order.
const repoRank = (group: ProjectGroup): number => {
  const ranks = group.workspaces.flatMap((entry) => (entry.board ? [seatRank(entry.workspace)] : []));
  return ranks.length ? Math.min(...ranks) : 4;
};

// Top: BRO boards, all idle. Active: a board is being worked on. Idle: P0 to P2 work waits and nothing is
// paused. Quiet: everything else, paused or stuck included.
export function sectionOf(group: ProjectGroup): SectionId {
  const boards = group.workspaces.flatMap((entry) => (entry.board ? [entry.board] : []));
  const bro = broBoards(group);
  if (bro.length) return bro.every(isIdle) ? "top" : "active";
  if (boards.some((board) => kindCount(board, "active") > 0)) return "active";
  const paused = boards.some((board) => board.hold || kindCount(board, "stuck") > 0 || kindCount(board, "stale") > 0);
  return !paused && boards.some((board) => board.autoCount > 0) ? "idle" : "quiet";
}

export function buildSections(groups: ProjectGroup[]): { id: SectionId; title: string; sub: string; foldedByDefault: boolean; groups: ProjectGroup[] }[] {
  return (Object.keys(SECTIONS) as SectionId[])
    .map((id) => ({ id, ...SECTIONS[id], groups: groups.filter((group) => sectionOf(group) === id).sort((a, b) => repoRank(a) - repoRank(b)) }))
    .filter((section) => section.groups.length);
}

// A board counts once for each state it is in; chats are workspaces with live
// agents and no board.
export function headerCounts(groups: ProjectGroup[]): { boards: number; repos: number; active: number; stuck: number; stale: number; chats: number } {
  const entries = groups.flatMap((group) => group.workspaces);
  const boards = entries.flatMap((entry) => (entry.board ? [entry.board] : []));
  const having = (kind: Indicator["kind"]) => boards.filter((board) => kindCount(board, kind) > 0).length;
  return { boards: boards.length, repos: groups.length, active: having("active"), stuck: having("stuck"), stale: having("stale"), chats: entries.filter(isChat).length };
}

export function headerLine(counts: ReturnType<typeof headerCounts>): { before: string; stuck: string; after: string } {
  return {
    before: `${plural(counts.boards, "board")} in ${plural(counts.repos, "repo")} · ${counts.active} active · `,
    stuck: `${counts.stuck} stuck`,
    after: ` · ${counts.stale} stale · ${plural(counts.chats, "chat")} without a board`,
  };
}

// ── The five-state selector's words. Fullauto and clear are started by the
// seat itself, so the hint says who is asked. Hold and spec are set at once.
const NO_SEAT = "No live agent on this board to start it.";

export function optionHint(option: BoardMode, owner: string | null, conn: Conn | null): string {
  switch (option) {
    case "manual":
      return conn ? (owner ? `Asks ${owner} to turn full auto off.` : "No live agent on this board to turn full auto off.") : "You pick the work. Nothing starts on its own.";
    case "hold": return "Pauses the board: nothing new starts. Set at once.";
    case "spec": return "Pauses new work while objectives are written up. Set at once.";
    case "clear": return owner ? `Asks ${owner} to clear the board: finish the open P0–P2 work, then stop.` : NO_SEAT;
    case "fullauto": return owner ? `Asks ${owner} to start full auto: it works P0–P2 objectives without asking.` : NO_SEAT;
  }
}

export function resultLine(result: { mode: BoardMode; pinged: boolean; error?: string }, owner: string | null): { tone: "ok" | "warning"; text: string } {
  if (result.error) return { tone: "warning", text: `${result.error} The board change still stands.` };
  return { tone: "ok", text: result.pinged ? `Told ${owner ?? "the owner"}.` : `Board set to ${MODE_LABEL[result.mode]}.` };
}

// The card grid: columns by the grid's own measured width (3 from 900, 2 from
// 620, else 1), and a whole-pixel card width that leaves slack, so the cards
// never add up wider than the container and wrap early.
export function gridLayout(containerWidth: number, gap: number): { columns: number; cardWidth: number } {
  const columns = containerWidth >= 900 ? 3 : containerWidth >= 620 ? 2 : 1;
  return { columns, cardWidth: Math.max(0, Math.floor((containerWidth - 1 - gap * (columns - 1)) / columns)) };
}

// "Agents without a board" is a card among the board cards. When it would start
// a new row alone it takes the whole row; beside a board it keeps a card's width.
export function chatsSpan(columns: number, boards: number): "card" | "full" {
  return columns === 1 || boards % columns === 0 ? "full" : "card";
}

// The state strip is icons only so it always fits one row. The word stays
// MODE_LABEL's, and the page uses it as each button's tooltip and aria-label.
const MODE_ICON: Record<BoardMode, string> = {
  manual: "CornerDownLeft",
  hold: "Pause",
  spec: "NotebookPen",
  clear: "ArrowDownToDot",
  fullauto: "Infinity",
};
export const MODE_BUTTONS: { mode: BoardMode; icon: string; label: string }[] = BOARD_MODES.map((mode) => ({ mode, icon: MODE_ICON[mode], label: MODE_LABEL[mode] }));

// o38.1 and o38.2: what the archive confirm says. A workspace takes everything
// it owns with it, so its agents are counted; running work is named, since
// archiving interrupts it. A board's file stays in the repo.
export type ArchiveTarget =
  | { kind: "workspace"; name: string; agents: number; running: number; board: string | null }
  | { kind: "agent"; name: string; running: boolean };

export function archiveConfirm(target: ArchiveTarget): { title: string; body: string; action: string } {
  if (target.kind === "agent") {
    return {
      title: "Archive agent?",
      action: "Archive agent",
      body: `"${target.name}" is archived and leaves the dashboard.${target.running ? " It is running, so this interrupts it." : ""}`,
    };
  }
  const withBoard = target.board !== null;
  const noun = withBoard ? "board and workspace" : "workspace";
  const goes = target.agents ? ` ${target.agents} ${target.agents === 1 ? "agent goes" : "agents go"} with it.` : "";
  const busy = target.running ? ` ${target.running} ${target.running === 1 ? "is" : "are"} running and will be interrupted.` : "";
  return {
    title: `Archive ${noun}?`,
    action: `Archive ${noun}`,
    body: `"${target.name}"${withBoard ? " and its board leave" : " leaves"} the dashboard.${goes}${busy}${withBoard ? " The board's file stays in the repo." : ""}`,
  };
}

// "All close/idle commands must be modaled" (Des, 16 Oct): moving a board to
// Manual, Hold or Spec asks first. Clear the board and Full auto start work, so
// they go straight through. `fullAuto` is a full auto already on the board,
// which a hold or spec leaves running underneath.
export function modeConfirm(
  to: BoardMode,
  board: { name: string; owner: string | null; fullAuto: boolean; held: boolean },
): { title: string; body: string; action: string } | null {
  const name = `"${board.name}"`;
  const underneath = board.fullAuto ? " Full auto stays on underneath and carries on when you lift this." : "";
  switch (to) {
    case "hold":
      return { title: "Put the board on hold?", action: "Put on hold", body: `${name} is paused: items can still be added, but nothing new starts.${underneath}` };
    case "spec":
      return { title: "Switch the board to Spec?", action: "Switch to Spec", body: `${name} pauses new work while objectives are written up.${underneath}` };
    case "manual": {
      const off = board.fullAuto ? (board.owner ? ` Asks ${board.owner} to turn full auto off.` : " No live agent on this board to turn full auto off, so it stays on.") : " Nothing starts on its own.";
      return { title: "Switch the board to Manual?", action: "Switch to Manual", body: `${name} goes back to you picking the work.${board.held ? " The hold is lifted." : ""}${off}` };
    }
    default:
      return null;
  }
}

// o38.11 (Des, 16 Oct): repos with few cards share a row instead of wasting it.
// A repo's cards are its boards plus one for the agents without a board.
export function cardCount(group: ProjectGroup): number {
  const { boards, chats } = splitGroup(group);
  return boards.length + (chats.length ? 1 : 0);
}

// A repo takes as many columns as it has cards; three or more is a whole row.
export const repoSpan = (cards: number, columns: number) => Math.max(1, Math.min(cards, columns));

// Repos fill rows in their own order, so rows are 1-1-1, 1-2 or 2-1 and never
// 1-3; a repo sits alone only when the next one does not fit beside it. Returns
// the repo indexes of each row.
export function packRepos(spans: number[], columns: number): number[][] {
  const rows: number[][] = [];
  let used = 0;
  spans.forEach((span, index) => {
    if (!rows.length || used + span > columns) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push(index);
    used += span;
  });
  return rows;
}

// The width of `span` columns of cards with the gaps between them.
export const spanWidth = (span: number, cardWidth: number, gap: number) => span * cardWidth + (span - 1) * gap;

// o38.13 (Des, 16 Oct): the whole board card takes a very faint tint of its
// shown mode. Manual stays as it is; a hold shows its own tint over any full
// auto underneath, as the mode strip does.
export const MODE_TINT: Record<BoardMode, string | null> = {
  manual: null,
  hold: "rgba(214, 178, 74, 0.09)",
  spec: "rgba(168, 140, 226, 0.09)",
  clear: "rgba(150, 214, 150, 0.08)",
  fullauto: "rgba(84, 190, 112, 0.10)",
};
