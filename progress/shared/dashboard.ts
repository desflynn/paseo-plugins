import { CLOSE_REASONS, DELIVERABLE_KINDS, EVENT_VERSION, eventSchema, type BoardStatus, type CloseReason, type ConnMode, type FileLink, type HoldKind, type ProgressEvent, type QuestionOption, type TicketStatus } from "./events.ts";

// One recorded change to a ticket, oldest first. `stage: ""` clears the stage.
export interface TicketChange {
  at: string;
  status?: BoardStatus;
  stage?: string;
  note?: string;
}

export interface Ticket {
  id: string;
  title: string;
  estimateMin: number;
  // The Beads vocabulary: open/closed with a close reason, in_progress when
  // work begins. Legacy event words were translated on the fold.
  status: BoardStatus;
  // Why it closed: done or skipped. Set whenever the ticket is closed.
  closeReason?: CloseReason;
  // How urgent it is, Beads-style: 0 lowest to 4 highest.
  priority?: number;
  // When the ticket entered its current status.
  statusSince: string;
  // When the ticket last began work (entered in_progress).
  startedAt?: string;
  stage?: string;
  stageSince?: string;
  note?: string;
  // The ticket this one waits for, while that ticket isn't done or skipped yet.
  // Waiting is the order of work, not a problem, so it never counts as stuck.
  waitingFor?: { id: string; title: string };
  waitsFor?: string;
  // Where the ticket is written up: a spec file or an issue link.
  source?: FileLink;
  // Where the work came from: `bead:<id>`, `gh:<owner>/<repo>#<n>` or `teams:<messageId>`.
  ref?: string;
  // Newer tickets carry several refs at once (a bead and its GitHub issue);
  // older ones carry the single `ref`.
  refs?: string[];
  // The Paseo agent that last added or updated it, when written from Paseo.
  agentId?: string;
  // The ticket's owning workspace, so a union board can tell two scopes'
  // same-minted ids apart.
  ws?: string;
  // The parent objective, when this one is nested (O1800). Migrated form.
  under?: string;
  // Every status, stage and note change, starting with when it was added.
  history: TicketChange[];
}

export type StuckItem =
  | { kind: "blocked"; key: string; ticketId: string; title: string; since: string; note?: string }
  // A working ticket with no update for longer than its estimate. `since` is its last update.
  | { kind: "overdue"; key: string; ticketId: string; title: string; since: string; estimateMin: number }
  | { kind: "manual"; key: string; id: string; ticketId?: string; title: string; reason: string; since: string };

export interface Question {
  id: string;
  title: string;
  question: string;
  options: QuestionOption[];
  // The option the agent leans toward. Nothing is built until the user answers.
  recommended: string;
  background?: string;
  files: FileLink[];
  raisedBy?: string;
  ticketId?: string;
  askedAt: string;
  // `changedCourse` only on older answers, from when agents built a default before asking.
  answer?: { choice: string; words?: string; changedCourse?: boolean; at: string };
}

export interface Deliverable {
  id: string;
  title: string;
  path?: string;
  url?: string;
  ticketId?: string;
  // Short name of the ticket, like "Ticket 03", when the ticket still exists.
  ticketLabel?: string;
  kind?: (typeof DELIVERABLE_KINDS)[number];
  addedAt: string;
}

export interface Activity {
  id: string;
  text: string;
  ticketId?: string;
  at: string;
  editedAt?: string;
}

// One comma-separated part of the headline, e.g. "1 stuck" in the alert color.
export interface HeadlinePart {
  text: string;
  tone: "normal" | "danger";
}

// Something in the file the dashboard could not use. The panel lists these so
// one bad write is visible without hiding the rest.
export interface FileIssue {
  line: number;
  reason: string;
}

export interface ProgressSegment {
  id: string;
  estimateMin: number;
  status: TicketStatus;
  waiting?: boolean;
}

// Conn ("full auto"): state the DCI engine writes with conn set and rewrites on
// every nudge. `since` is when it first came on (kept across rewrites).
export interface Conn {
  on: true;
  budget: number;
  mode: ConnMode;
  nextNudgeAt: string;
  since: string;
  // Full auto clear: work the board down, then turn off at idle. The engine
  // owns the behaviour; set only while the last write carried --clear.
  clear?: true;
}

// Hold: the owner's board-wide stop (o34). Items can still be added, but no
// work starts. `since` is when it first came on, kept across rewrites.
export interface Hold {
  on: true;
  kind: HoldKind;
  note?: string;
  since: string;
}

export interface Dashboard {
  run: {
    title: string;
    subtitle?: string;
    itemLabel: string;
    startedAt: string;
    // Set by `finish`: the run is over and the next work starts a new one.
    finished?: { at: string; outcome: string };
  } | null;
  updatedAt: string | null;
  // Nothing recorded for STALE_AFTER_MIN while tickets remain: the work may have stopped.
  stale: boolean;
  headline: HeadlinePart[];
  stuck: StuckItem[];
  // Open questions in ask order; answered ones, most recently answered first.
  questions: { open: Question[]; answered: Question[] };
  // Newest first.
  deliverables: Deliverable[];
  // Newest first.
  activity: Activity[];
  // `by` is the Paseo agent that set it, when set from Paseo.
  ticker: { text: string; since: string; by?: string } | null;
  // The conn state, present only while conn is on.
  conn?: Conn;
  // The hold state, present only while the board is on hold.
  hold?: Hold;
  // Share of estimated minutes in done tickets. Skipped tickets are left out.
  // `tookMin`: once every counted ticket is done, the real time from the run's
  // start to the last one finishing.
  progress: { percent: number; doneMin: number; totalMin: number; tookMin?: number; segments: ProgressSegment[] };
  tickets: Ticket[];
  issues: FileIssue[];
}

// The id the next add of each kind gets. Ids are never reused, even after a
// remove. Question ids stay unique across runs, so an answer like "Q7 A" can't
// land on a question from an earlier run; the rest restart with each run.
export interface NextIds {
  ticket: string;
  question: string;
  deliverable: string;
  activity: string;
  stuck: string;
}

export interface ParsedLine {
  line: number;
  event: ProgressEvent;
  // In the union fold: the scope whose slice this line came from. The union
  // keys a run by this, not by each event's own ws, so a run's continuation
  // stays part of that run whatever ws later events carry.
  foldScope?: string;
  // A line a move correction re-homed (o21): the fold keys its ticket apart,
  // so it never merges with a ticket the target minted under the same id.
  moved?: boolean;
}

// Reads the JSONL text. A last line without a newline may be half written by
// a command that is still running, so it is skipped without an issue.
export function parseProgress(text: string): { events: ParsedLine[]; issues: FileIssue[] } {
  const events: ParsedLine[] = [];
  const issues: FileIssue[] = [];
  // Whether or not the text ends in a newline, the last split piece is either
  // empty or unfinished.
  text.split("\n").slice(0, -1).forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      issues.push({ line, reason: "not valid JSON" });
      return;
    }
    const parsed = eventSchema.safeParse(json);
    if (parsed.success) events.push({ line, event: parsed.data });
    else issues.push({ line, reason: describeInvalid(json) });
  });
  return { events, issues };
}

function describeInvalid(json: unknown): string {
  const version = typeof json === "object" && json !== null && "v" in json ? (json as { v: unknown }).v : undefined;
  if (typeof version === "number" && version !== EVENT_VERSION) return `written by a newer version of the plugin (v${version})`;
  const type = typeof json === "object" && json !== null && "type" in json ? String((json as { type: unknown }).type) : null;
  return type ? `invalid ${type} event` : "not a progress event";
}

export const STALE_AFTER_MIN = 15;

// Every time-dependent rule asks `reached(at)` instead of comparing with `now`
// itself. Each answer also records the moment it would flip, so `validUntil`
// is the first millisecond at which the same events can produce a different
// dashboard, and a new rule can't forget to tell the cache.
function clock(now: Date) {
  let validUntil = Infinity;
  return {
    reached(at: number): boolean {
      if (now.getTime() >= at) return true;
      validUntil = Math.min(validUntil, at);
      return false;
    },
    get validUntil() {
      return validUntil;
    },
  };
}

export function isSettled(ticket: Ticket): boolean {
  return ticket.status === "closed";
}

// The Beads vocabulary (O1700): the fold translates the 0.4.0 words on the
// way in, so historical files read as the same system the Beads tab shows.
export function normalizeStatus(status: TicketStatus | undefined): { status: BoardStatus; closeReason?: CloseReason } {
  switch (status) {
    case undefined:
    case "not_started":
      return { status: "open" };
    case "working":
      return { status: "in_progress" };
    case "done":
      return { status: "closed", closeReason: "done" };
    case "skipped":
      return { status: "closed", closeReason: "skipped" };
    default:
      return { status };
  }
}

// The union scope: All folds every scope's current run together into one
// board (owner union, revision 5). Distinct from undefined, which stays the
// unscoped 0.4.0 latest-run fold.
export const UNION_SCOPE = "*";

// The Paseo agent registry, agent id → workspaceId (o20). When the caller
// passes it, the fold attributes unscoped events to their `by` agent's
// workspace; without it every fold is exactly as before.
export type AgentWorkspaces = { get(agentId: string): string | undefined };

// The events from the last `run.start` on; earlier runs are ignored.
export function latestRun(events: ParsedLine[]): ParsedLine[] {
  const start = events.findLastIndex(({ event }) => event.type === "run.start");
  return events.slice(Math.max(start, 0));
}

// The ticket events a move correction re-homes (o21).
const isTicketEvent = (event: ProgressEvent): event is Extract<ProgressEvent, { type: "ticket.add" | "ticket.update" | "ticket.remove" }> =>
  event.type === "ticket.add" || event.type === "ticket.update" || event.type === "ticket.remove";

// One reallocation (o21): the target workspace and, when the target later
// mints its own ticket under the same id, the line of that add — from there
// on, the target's stamped events are its own ticket, not the moved one.
type Move = { to: string; ownMint?: number };
type Moves = { moves: Map<string, Move>; from: number };

// The reallocations the fold honours (o21): display id → move, last move
// wins, read from the oldest run still on screen (the latest unscoped run and
// each workspace's latest run), so a target starting its own run after the
// move never drops it. Children follow the parent: a ticket added under a
// moved parent moves with it, any depth. The event log is never rewritten —
// this map is the whole correction, applied at read time.
function movedTargets(events: ParsedLine[]): Moves {
  const starts = new Map<string, number>();
  events.forEach(({ event }, index) => { if (event.type === "run.start") starts.set(event.ws ?? "", index); });
  const window = events.slice(starts.size ? Math.min(...starts.values()) : 0);
  const from = window[0]?.line ?? 0;
  const moves = new Map<string, Move>();
  const movedAt = new Map<string, number>();
  for (const { line, event } of window) {
    if (event.type !== "ticket.move") continue;
    moves.set(displayId(event.id), { to: event.to });
    movedAt.set(displayId(event.id), line);
  }
  if (!moves.size) return { moves, from };
  for (const { line, event } of window) {
    if (event.type !== "ticket.add" || event.ws === undefined) continue;
    const move = moves.get(displayId(event.id));
    if (move && move.ownMint === undefined && event.ws === move.to && line > movedAt.get(displayId(event.id))!) move.ownMint = line;
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const { event } of window) {
      if (event.type !== "ticket.add" || event.under === undefined) continue;
      const parent = moves.get(displayId(event.under));
      const id = displayId(event.id);
      if (parent !== undefined && !moves.has(id)) {
        moves.set(id, { to: parent.to });
        grew = true;
      }
    }
  }
  return { moves, from };
}

// The move that re-homes this line, if any: ticket events of a moved id
// inside the window, except the target's own stamped events after it minted
// its own ticket under that id.
function moveOf({ line, event }: ParsedLine, { moves, from }: Moves): Move | undefined {
  if (line < from || !(isTicketEvent(event) || event.type === "ticket.move")) return undefined;
  const move = moves.get(displayId(event.id));
  if (!move) return undefined;
  if (move.ownMint !== undefined && line >= move.ownMint && event.ws === move.to) return undefined;
  return move;
}

// The home workspace of each unscoped ticket event, by file line. A stamped
// add sets its ticket's home; a ticket added unscoped takes its home from the
// first stamped event naming it, and keeps it for every later unscoped event.
// Earlier unscoped events wait for that first stamped one. Ids go through the
// T→o migration. An event with no stamped relative falls back to its writer.
function ticketHomes(events: ParsedLine[]): Map<number, string> {
  const homes = new Map<number, string>();
  const home = new Map<string, string>();
  const waiting = new Map<string, number[]>();
  for (const { line, event } of events) {
    if (!isTicketEvent(event)) continue;
    const id = displayId(event.id);
    if (event.ws !== undefined) {
      if (event.type === "ticket.add" || !home.has(id)) home.set(id, event.ws);
      for (const earlier of waiting.get(id) ?? []) homes.set(earlier, event.ws);
      waiting.delete(id);
    } else if (home.has(id)) {
      homes.set(line, home.get(id)!);
    } else {
      waiting.set(id, [...(waiting.get(id) ?? []), line]);
    }
  }
  return homes;
}

// The events one workspace's scope shows, so two workspaces on one checkout
// stop evicting each other. Three choices, separate on purpose:
// - Run-slot: with a scope, the boundary is the last `run.start` carrying that
//   `ws`; an unscoped start claims the slot only in a scope that has no scoped
//   start of its own. With no scope, the boundary is the last `run.start` in
//   the file, exactly as 0.4.0 did it.
// - Content: inside the selected run, an event with no `ws` stays visible in
//   every scope, so legacy events and unscoped writers are never filtered
//   away — except an unscoped `run.start`, which claims no header in a scope
//   with a run of its own (proof fix D-1).
// - Attribution (o20, workspace-first default): when the caller passes the
//   agent registry, an unscoped event keeps its place in this scope only if
//   its `by` agent belongs to this workspace; everything else falls to the
//   global bucket (--all only). A file with no ws events at all never
//   attributes: the no-ws class keeps the byte-identical 0.4.0 fold. An
//   unscoped ticket event follows its ticket's home first (ticketHomes), so a
//   seat from another workspace closing this workspace's ticket lands here.
// - Reallocation (o21): a `ticket.move` correction re-homes its ticket's
//   events — every other scope loses them, the target gains them wherever
//   they sit in the file, even when the target never started a run here. The
//   unscoped 0.4.0 fold (no scope) ignores moves, so legacy files read on.
export function scopeEvents(events: ParsedLine[], scope?: string, agentWs?: AgentWorkspaces): ParsedLine[] {
  if (scope === UNION_SCOPE) return unionEvents(events, agentWs);
  if (scope === undefined) return latestRun(events);
  const moved = movedTargets(events);
  // Work reallocated into this workspace (o21) renders here wherever its
  // events sit in the window — even when this workspace never started a run.
  // The move lines come along, so the board re-stamps the ticket's home.
  const movedIn = new Map<number, ParsedLine>();
  if (moved.moves.size) {
    for (const parsed of events) {
      if (moveOf(parsed, moved)?.to === scope) movedIn.set(parsed.line, { ...parsed, moved: true });
    }
  }
  let start = events.findLastIndex(({ event }) => event.type === "run.start" && event.ws === scope);
  const ownRun = start >= 0;
  if (!ownRun) start = events.findLastIndex(({ event }) => event.type === "run.start" && event.ws === undefined);
  // This workspace has never started a run here, so it sees nothing — except
  // work reallocated to it. Without the bail, `Math.max(start, 0)` would
  // slice from the top of the file and hand the scope another workspace's
  // stray unscoped events.
  if (start < 0) return [...movedIn.values()].sort((a, b) => a.line - b.line);
  const attribute = agentWs !== undefined && events.some(({ event }) => event.ws !== undefined);
  const homes = attribute ? ticketHomes(events) : new Map<number, string>();
  const slice: ParsedLine[] = [];
  for (const parsed of events.slice(start)) {
    const { event } = parsed;
    // Moved elsewhere: every other scope loses the event. Moved here: it keeps
    // its file place (movedIn holds it for the merge below). A move line
    // outside the window corrects nothing and renders nowhere.
    if (event.type === "ticket.move" || moveOf(parsed, moved)) {
      if (movedIn.has(parsed.line)) slice.push(movedIn.get(parsed.line)!);
      continue;
    }
    if (event.ws === scope
      || (event.ws === undefined && !(ownRun && event.type === "run.start")
        && (!attribute || (homes.get(parsed.line) ?? agentWs?.get(event.by ?? "")) === scope))) slice.push(parsed);
  }
  // Moved-in events from before this scope's run.start join the front, so
  // the fold sees the ticket from its add.
  if (movedIn.size) {
    const taken = new Set(slice.map(({ line }) => line));
    for (const [line, parsed] of movedIn) if (!taken.has(line)) slice.push(parsed);
    slice.sort((a, b) => a.line - b.line);
  }
  return slice;
}

// The union fold: every scope's current run, each event once, in file order —
// one board with both runs' tickets (owner union, revision 5). Unscoped
// events shared by two scoped runs appear once. A file with no workspace
// events folds exactly as 0.4.0 did. With attribution on (o20), an unscoped
// event lands in its agent's workspace's slice, and the events no slice took
// — unresolvable `by`, no `by`, or an agent whose workspace has no run here —
// form the global bucket, rendered only via --all and tagged to no workspace.
function unionEvents(events: ParsedLine[], agentWs?: AgentWorkspaces): ParsedLine[] {
  // Every workspace that stamped anything, not only those with a run.start of
  // their own: a workspace writing into a shared run shows in All with the
  // same slice its WS view folds. Run starters come first, in file order.
  const scopes = new Set(events.flatMap(({ event }) => (event.type === "run.start" && event.ws !== undefined ? [event.ws] : [])));
  for (const { event } of events) if (event.ws !== undefined) scopes.add(event.ws);
  if (scopes.size === 0) return latestRun(events);
  const moved = movedTargets(events);
  const seen = new Set<number>();
  const union: ParsedLine[] = [];
  const take = (parsed: ParsedLine[], foldScope: string) => {
    for (const line of parsed) {
      if (seen.has(line.line)) continue;
      seen.add(line.line);
      // Tag each line with the slice it came from, so the union keys by the
      // run's scope, not by each event's own ws (proof fix D-2).
      union.push({ ...line, foldScope });
    }
  };
  for (const scope of scopes) take(scopeEvents(events, scope, agentWs), scope);
  // The global bucket: whatever the slices left behind. Stray unscoped
  // `run.start`s stay out — D-1 keeps them out of the union as before.
  // Only from the runs still on screen: an earlier run's leftovers are history.
  if (agentWs !== undefined) {
    take(events.filter(({ line, event }) =>
      line >= moved.from && !seen.has(line) && event.type !== "run.start" && event.ws === undefined), "");
  }
  // Moved work whose target has no run of its own (o21): the slices left it
  // behind, so this bucket keeps it visible in --all, homed on the target
  // below. The move lines ride along once, for the audit trail.
  if (moved.moves.size) {
    take(events.filter((parsed) => !seen.has(parsed.line) && moveOf(parsed, moved)), "");
    // o21: a moved ticket's events carry the target's key, so the union board
    // homes the ticket on the workspace it was moved to.
    for (const parsed of union) {
      const move = moveOf(parsed, moved);
      if (move) Object.assign(parsed, { foldScope: move.to, moved: true });
    }
  }
  return union.sort((a, b) => a.line - b.line);
}

// Folds the events of the latest run into what the panel shows at `now`, how
// long that stays true while the events don't change, and the ids new items get.
// Everything before the last `run.start` belongs to earlier runs and is ignored.
// `agentWs`, when given, turns on workspace-first attribution (o20).
export function reduceProgress(parsed: { events: ParsedLine[]; issues: FileIssue[] }, now: Date, scope?: string, agentWs?: AgentWorkspaces): { dashboard: Dashboard; validUntil: number; nextIds: NextIds } {
  const time = clock(now);
  const events = scopeEvents(parsed.events, scope, agentWs);
  // In the union fold, ids minted per scope may repeat, so every id is keyed
  // by its run's scope ("" for legacy events) and the ticket carries that
  // scope as its ws. One board, both T01s. Every key goes through the
  // migration, so a legacy T02 and a new o2 name the same ticket everywhere.
  const union = scope === UNION_SCOPE;
  const key = (ws: string | undefined, id: string) => {
    const migrated = displayId(id);
    return union ? `${ws ?? ""}/${migrated}` : migrated;
  };
  // A moved ticket (o21) keys apart, so it never merges with a ticket the
  // target minted under the same id; `wsKey` is set per line below.
  let wsKey: string | undefined;
  const movedTickets = new WeakSet<Ticket>();
  const ticketKey = (moved: boolean | undefined, id: string) => `${moved ? ">" : ""}${key(wsKey, id)}`;
  const issues = [...parsed.issues];
  let run: Dashboard["run"] = null;
  const tickets = new Map<string, Ticket>();
  // Keys whose current ticket was minted by a scoped (ws-tagged) event, for
  // the D-4 guard on ticket.add below.
  const scopedMints = new Set<string>();
  const questions = new Map<string, Question>();
  const deliverables = new Map<string, Deliverable>();
  const activity = new Map<string, Activity>();
  let ticker: Dashboard["ticker"] = null;
  let conn: Conn | undefined;
  let hold: Hold | undefined;
  const manualStuck = new Map<string, { id: string; reason: string; ticket?: string; since: string }>();
  let updatedAt: string | null = null;

  for (const parsed of events) {
    const { line, event } = parsed;
    // In the union fold a run's continuation is that run whatever ws later
    // events carry, so every id is keyed by the slice's scope, not the
    // event's own ws (proof fix D-2). Outside the union, the event's own ws.
    wsKey = union ? parsed.foldScope : event.ws;
    updatedAt = event.ts;
    switch (event.type) {
      case "run.start":
        run = { title: event.title, subtitle: event.subtitle, itemLabel: event.itemLabel ?? "Objective", startedAt: event.ts };
        break;
      case "run.finish":
        if (run) run.finished = { at: event.ts, outcome: event.outcome };
        ticker = null;
        break;
      case "run.rename":
        // A workspace whose slice holds no run.start of its own (its run header
        // is a legacy start another workspace owns) still takes the new name:
        // the rename itself gives the board its header.
        if (!run) run = { title: "Progress", itemLabel: "Objective", startedAt: event.ts };
        if (event.title !== undefined) run.title = event.title;
        if (event.subtitle !== undefined) run.subtitle = event.subtitle || undefined;
        break;
      case "ticket.add": {
        const k = ticketKey(parsed.moved, event.id);
        // D-4 (O1000): an unscoped writer's add must not take a scoped
        // ticket's place (design A.5, owner ruling). Nothing scoped is ever
        // minted in a file with no ws events, so such a file folds exactly as
        // 0.4.0 did; a no-ws ticket.update still reaches the scoped ticket.
        if (scopedMints.has(k) && event.ws === undefined) break;
        if (event.ws !== undefined) scopedMints.add(k);
        const added = normalizeStatus(event.status);
        tickets.set(k, {
          id: displayId(event.id),
          title: event.title,
          estimateMin: event.estimateMin,
          status: added.status,
          closeReason: added.closeReason,
          priority: event.priority,
          statusSince: event.ts,
          startedAt: added.status === "in_progress" ? event.ts : undefined,
          history: [{ at: event.ts, status: added.status }],
          waitsFor: event.waitsFor,
          source: event.source,
          ref: event.ref,
          refs: event.refs,
          under: event.under ? displayId(event.under) : undefined,
          ws: wsKey,
          agentId: event.by,
        });
        if (parsed.moved) movedTickets.add(tickets.get(k)!);
        break;
      }
      case "ticket.update": {
        const ticket = tickets.get(ticketKey(parsed.moved, event.id));
        if (!ticket) {
          issues.push({ line, reason: `unknown ticket ${event.id}` });
          break;
        }
        if (event.title !== undefined) ticket.title = event.title;
        if (event.estimateMin !== undefined) ticket.estimateMin = event.estimateMin;
        const incoming = normalizeStatus(event.status);
        const change: TicketChange = { at: event.ts };
        if (event.status !== undefined && incoming.status !== ticket.status) change.status = incoming.status;
        if (event.stage !== undefined && event.stage !== (ticket.stage ?? "")) change.stage = event.stage;
        if (event.note) change.note = event.note;
        if (Object.keys(change).length > 1) ticket.history.push(change);
        if (event.status !== undefined && incoming.status !== ticket.status) {
          ticket.status = incoming.status;
          ticket.statusSince = event.ts;
          if (incoming.status === "in_progress") ticket.startedAt = event.ts;
          if (incoming.status !== "closed") ticket.closeReason = undefined;
        }
        // Closing carries a reason: the event's own, the translated legacy
        // one, or the default when a bare `closed` arrives.
        if (event.closeReason !== undefined) ticket.closeReason = event.closeReason;
        else if (event.status !== undefined && incoming.status === "closed") ticket.closeReason = incoming.closeReason ?? ticket.closeReason ?? "done";
        if (event.priority !== undefined) ticket.priority = event.priority;
        if (event.stage !== undefined && event.stage !== (ticket.stage ?? "")) {
          ticket.stage = event.stage || undefined;
          ticket.stageSince = event.stage ? event.ts : undefined;
        }
        if (event.note !== undefined) {
          const nextNote = event.note || undefined;
          // A close carries the proof of done. Append it, so the GOAL written when
          // the objective was filed survives the close (o64).
          const closing = event.status !== undefined && incoming.status === "closed";
          ticket.note = closing && nextNote && ticket.note ? `${ticket.note}\n\n${nextNote}` : nextNote;
        }
        if (event.waitsFor !== undefined) ticket.waitsFor = event.waitsFor || undefined;
        if (event.source !== undefined) ticket.source = event.source || undefined;
        if (event.ref !== undefined) ticket.ref = event.ref;
        if (event.refs !== undefined) ticket.refs = event.refs;
        if (event.under !== undefined) ticket.under = event.under ? displayId(event.under) : undefined;
        if (union) ticket.ws = wsKey;
        else if (event.ws !== undefined) ticket.ws = event.ws;
        if (event.by) ticket.agentId = event.by;
        break;
      }
      case "ticket.remove": {
        const k = ticketKey(parsed.moved, event.id);
        if (tickets.delete(k)) scopedMints.delete(k);
        else issues.push({ line, reason: `unknown ticket ${event.id}` });
        break;
      }
      case "ticket.move": {
        // The reallocation itself is applied by the scope filter; here it
        // re-stamps the ticket's home workspace on this board.
        const ticket = tickets.get(ticketKey(parsed.moved, event.id));
        if (!ticket) issues.push({ line, reason: `unknown ticket ${event.id}` });
        else ticket.ws = event.to;
        break;
      }
      case "question.ask":
        questions.set(key(wsKey, event.id), {
          id: event.id,
          title: event.title,
          question: event.question,
          options: event.options ?? [],
          recommended: event.recommend ?? event.default ?? "",
          background: event.background,
          files: event.files ?? [],
          raisedBy: event.raisedBy,
          ticketId: event.ticket ? displayId(event.ticket) : undefined,
          askedAt: event.ts,
        });
        break;
      case "question.answer": {
        const question = questions.get(key(wsKey, event.id));
        if (!question) issues.push({ line, reason: `unknown question ${event.id}` });
        else question.answer = { choice: event.choice, words: event.words, changedCourse: event.changedCourse, at: event.ts };
        break;
      }
      case "question.update": {
        const question = questions.get(key(wsKey, event.id));
        if (!question) {
          issues.push({ line, reason: `unknown question ${event.id}` });
          break;
        }
        if (event.question !== undefined) question.question = event.question;
        if (event.background !== undefined) question.background = event.background;
        if (event.files !== undefined) question.files = [...question.files, ...event.files];
        break;
      }
      case "question.remove":
        if (!questions.delete(key(wsKey, event.id))) issues.push({ line, reason: `unknown question ${event.id}` });
        break;
      case "deliverable.add":
        deliverables.set(key(wsKey, event.id), {
          id: event.id,
          title: event.title,
          path: event.path,
          url: event.url,
          ticketId: event.ticket ? displayId(event.ticket) : undefined,
          kind: event.kind,
          addedAt: event.ts,
        });
        break;
      case "deliverable.remove":
        if (!deliverables.delete(key(wsKey, event.id))) issues.push({ line, reason: `unknown deliverable ${event.id}` });
        break;
      case "activity.add":
        activity.set(key(wsKey, event.id), { id: event.id, text: event.text, ticketId: event.ticket ? displayId(event.ticket) : undefined, at: event.ts });
        break;
      case "activity.update": {
        const entry = activity.get(key(wsKey, event.id));
        if (!entry) issues.push({ line, reason: `unknown activity ${event.id}` });
        else Object.assign(entry, { text: event.text, editedAt: event.ts });
        break;
      }
      case "activity.remove":
        if (!activity.delete(key(wsKey, event.id))) issues.push({ line, reason: `unknown activity ${event.id}` });
        break;
      case "ticker.set":
        ticker = { text: event.text, since: event.ts, ...(event.by ? { by: event.by } : {}) };
        break;
      case "ticker.clear":
        ticker = null;
        break;
      case "conn.set":
        conn = { on: true, budget: event.budget, mode: event.mode, nextNudgeAt: event.nextNudgeAt, since: conn?.since ?? event.ts, ...(event.clear ? { clear: true as const } : {}) };
        break;
      case "conn.clear":
        conn = undefined;
        break;
      case "hold.set":
        hold = { on: true, kind: event.kind, ...(event.note ? { note: event.note } : {}), since: hold?.since ?? event.ts };
        break;
      case "hold.clear":
        hold = undefined;
        break;
      case "stuck.set":
        manualStuck.set(key(wsKey, event.id), { id: event.id, reason: event.reason, ticket: event.ticket ? displayId(event.ticket) : undefined, since: event.ts });
        break;
      case "stuck.clear":
        if (!manualStuck.delete(key(wsKey, event.id))) issues.push({ line, reason: `unknown stuck item ${event.id}` });
        break;
    }
  }

  const list = [...tickets.values()];
  // Stuck roll-up (o18 / O2700, owner ruling): a parent never renders Stuck
  // while any descendant is live. Liveness rolls up — in_progress anywhere in
  // the subtree, or activity on it after the parent entered its current
  // status — and the parent renders in_progress with its stuck state
  // suppressed until no descendant is live. Derived from the events alone,
  // so the fold needs no new validity bound.
  const activityList = [...activity.values()];
  const childrenOf = new Map<string, Ticket[]>();
  for (const ticket of list) {
    if (!ticket.under) continue;
    const kids = childrenOf.get(ticket.under) ?? [];
    kids.push(ticket);
    childrenOf.set(ticket.under, kids);
  }
  const liveDescendants = (ticket: Ticket): boolean =>
    (childrenOf.get(ticket.id) ?? []).some((kid) =>
      kid.status === "in_progress"
      || liveDescendants(kid)
      || activityList.some((entry) => entry.ticketId === kid.id && Date.parse(entry.at) > Date.parse(ticket.statusSince)));
  const stuckSuppressed = new Set<string>();
  for (const ticket of list) {
    if (!liveDescendants(ticket)) continue;
    stuckSuppressed.add(ticket.id);
    if (ticket.status === "blocked") ticket.status = "in_progress";
  }
  for (const ticket of list) {
    // A moved ticket waits on its moved sibling first, then on the board's own.
    const waitKey = ticket.waitsFor ? key(ticket.ws, ticket.waitsFor) : undefined;
    const other = waitKey === undefined ? undefined
      : (movedTickets.has(ticket) ? tickets.get(`>${waitKey}`) : undefined) ?? tickets.get(waitKey);
    ticket.waitingFor = other && !isSettled(other) && !isSettled(ticket)
      ? { id: other.id, title: other.title }
      : undefined;
  }
  const itemLabel = run?.itemLabel ?? "Objective";
  const stuck = stuckItems(list, activityList, [...manualStuck.values()], time.reached, stuckSuppressed);
  const allQuestions = [...questions.values()];
  const open = allQuestions.filter((question) => !question.answer);
  // A finished run has nothing left to stall, so it never goes stale.
  const finished = Boolean(run?.finished) || (list.length > 0 && list.every(isSettled));
  const answered = allQuestions
    .filter((question) => question.answer)
    .sort((a, b) => Date.parse(b.answer!.at) - Date.parse(a.answer!.at));
  const dashboard: Dashboard = {
    run,
    updatedAt,
    stale: !finished && updatedAt !== null && time.reached(Date.parse(updatedAt) + STALE_AFTER_MIN * 60_000),
    headline: headline(list, itemLabel, open.length, owedStuck(stuck, list).length),
    stuck,
    questions: { open, answered },
    activity: [...activity.values()].reverse(),
    ticker,
    // Left out entirely while conn is off.
    ...(conn ? { conn } : {}),
    // Left out entirely while the board is not on hold.
    ...(hold ? { hold } : {}),
    deliverables: [...deliverables.values()].reverse().map((deliverable) => {
      const ticket = deliverable.ticketId ? tickets.get(deliverable.ticketId) : undefined;
      return ticket ? { ...deliverable, ticketLabel: shortTitle(ticket.title) } : deliverable;
    }),
    progress: progress(list, run?.startedAt),
    tickets: list,
    issues: issues.sort((a, b) => a.line - b.line),
  };
  // Id minting counts this scope's run's ticket.adds — including any since
  // reallocated away (o21), so a move never frees a spent number. Rendered
  // on the target, counted here.
  const moved = movedTargets(parsed.events);
  const idRun = moved.moves.size
    ? [...events, ...latestRun(parsed.events).filter((line) =>
        line.event.type === "ticket.add" && moveOf(line, moved) && !events.some((kept) => kept.line === line.line))]
    : events;
  return { dashboard, validUntil: time.validUntil, nextIds: nextIds(parsed.events.map(({ event }) => event), idRun.map(({ event }) => event)) };
}

function nextIds(all: ProgressEvent[], inRun: ProgressEvent[]): NextIds {
  const used = (events: ProgressEvent[], type: ProgressEvent["type"]) => events.flatMap((event) => (event.type === type && "id" in event ? [event.id] : []));
  return {
    ticket: nextObjectiveId(inRun),
    question: nextId("Q", used(all, "question.ask"), 1),
    deliverable: nextId("D", used(inRun, "deliverable.add"), 1),
    activity: nextId("A", used(inRun, "activity.add"), 1),
    stuck: nextId("S", used(inRun, "stuck.set"), 1),
  };
}

// The next top-level objective id: lowercase o plus the position after the
// highest taken. Both vocabularies count — legacy T01 is o1 — and numbers are
// never reused, so a removed ticket's number stays spent.
function nextObjectiveId(inRun: ProgressEvent[]): string {
  let max = 0;
  for (const event of inRun) {
    if (event.type !== "ticket.add") continue;
    const legacy = /^T0*(\d+)$/i.exec(event.id);
    const dotted = legacy ? null : /^o(\d+)(?:\.\d+)*$/i.exec(event.id);
    if (legacy) max = Math.max(max, Number(legacy[1]));
    else if (dotted) max = Math.max(max, Number(dotted[1]));
  }
  return `o${max + 1}`;
}

function progress(tickets: Ticket[], startedAt: string | undefined): Dashboard["progress"] {
  const counted = tickets.filter((ticket) => !(ticket.status === "closed" && ticket.closeReason === "skipped"));
  const totalMin = counted.reduce((sum, ticket) => sum + ticket.estimateMin, 0);
  const doneMin = counted.filter((ticket) => ticket.status === "closed").reduce((sum, ticket) => sum + ticket.estimateMin, 0);
  // All done: the last ticket to settle, done or skipped, ended the work.
  const allDone = counted.length > 0 && counted.every((ticket) => ticket.status === "closed") && tickets.every(isSettled);
  const endedAt = Math.max(...tickets.map((ticket) => Date.parse(ticket.statusSince)));
  return {
    percent: totalMin ? Math.round((doneMin / totalMin) * 100) : 0,
    doneMin,
    totalMin,
    tookMin: allDone && startedAt ? Math.max(0, (endedAt - Date.parse(startedAt)) / 60_000) : undefined,
    segments: counted.map(({ id, estimateMin, status, waitingFor }) => ({ id, estimateMin, status, waiting: Boolean(waitingFor) })),
  };
}

function lastTicketUpdate(ticket: Ticket, activity: Activity[]): number {
  return Math.max(
    ...ticket.history.map((change) => Date.parse(change.at)),
    ...activity.filter((entry) => entry.ticketId === ticket.id).map((entry) => Date.parse(entry.at)),
  );
}

function stuckItems(tickets: Ticket[], activity: Activity[], manual: Array<{ id: string; reason: string; ticket?: string; since: string }>, reached: (at: number) => boolean, stuckSuppressed: Set<string>): StuckItem[] {
  const items: StuckItem[] = [];
  for (const ticket of tickets) {
    // o18: a parent with a live descendant renders alive, not stuck.
    if (stuckSuppressed.has(ticket.id)) continue;
    // Blocked only on another ticket in the run is waiting, not stuck.
    if (ticket.status === "blocked" && !ticket.waitingFor) {
      items.push({ kind: "blocked", key: `blocked:${ticket.id}`, ticketId: ticket.id, title: ticket.title, since: ticket.statusSince, note: ticket.note });
    } else if (ticket.status === "in_progress") {
      // Any sign of work resets the clock: a status, stage or note change, or activity tagged to the ticket.
      const lastUpdate = lastTicketUpdate(ticket, activity);
      // Overdue once more than the estimate has passed, so a millisecond after it.
      if (reached(lastUpdate + ticket.estimateMin * 60_000 + 1)) {
        items.push({
          kind: "overdue",
          key: `overdue:${ticket.id}`,
          ticketId: ticket.id,
          title: ticket.title,
          since: new Date(lastUpdate).toISOString(),
          estimateMin: ticket.estimateMin,
        });
      }
    }
  }
  for (const item of manual) {
    if (item.ticket && stuckSuppressed.has(item.ticket)) continue;
    const ticket = item.ticket ? tickets.find((candidate) => candidate.id === item.ticket) : undefined;
    // A flag on an objective that has since finished no longer blocks anything.
    if (ticket && isFinished(ticket)) continue;
    items.push({
      kind: "manual",
      key: `manual:${item.id}`,
      id: item.id,
      ticketId: item.ticket,
      title: ticket?.title ?? item.reason,
      reason: item.reason,
      since: item.since,
    });
  }
  return items;
}

// "Ticket 03: Frozen links survive deletes" → "Ticket 03".
export function shortTitle(title: string): string {
  const index = title.indexOf(":");
  return index > 0 && index <= 24 ? title.slice(0, index) : title;
}

// One-time board migration (O1600): legacy T-ids display as o-ids, positionally
// — T01 → o1, T15 → o15. Historical JSONL is never rewritten; every fold
// translates on display, and all references resolve through the migrated form.
export function displayId(id: string): string {
  const match = /^T0*(\d+)$/i.exec(id);
  return match ? `o${Number(match[1])}` : id;
}

// A ticket's stored, CLI form of its name: the id, its provenance from the
// refs — the bead slug, the GitHub issue number — then the typed title:
// `o1.1-paseo-plugins-ti5-42 Fix the widget`. Parts appear only when present.
// Derived, never typed, so re-linking updates the name; tickets without refs
// keep their title as-is, so legacy boards read on unchanged.
export function ticketName(ticket: Pick<Ticket, "id" | "title" | "ref" | "refs">): string {
  const refs = [...(ticket.ref ? [ticket.ref] : []), ...(ticket.refs ?? [])];
  if (!refs.length) return ticket.title;
  const bead = refs.find((entry) => entry.startsWith("bead:"))?.slice(5);
  const ghNumber = refs.find((entry) => entry.startsWith("gh:"))?.match(/#(\d+)$/)?.[1];
  const provenance = `${bead ? `-${bead}` : ""}${ghNumber ? `-${ghNumber}` : ""}`;
  return `${ticket.id}${provenance} ${ticket.title}`;
}

// The ticket's linkage, parsed for the panel's chips: the bead slug and the
// GitHub issue it came from. Parts appear only when present.
export function ticketRefs(ticket: Pick<Ticket, "ref" | "refs">): { bead?: string; gh?: { owner: string; repo: string; number: number } } {
  const refs = [...(ticket.ref ? [ticket.ref] : []), ...(ticket.refs ?? [])];
  const out: { bead?: string; gh?: { owner: string; repo: string; number: number } } = {};
  const bead = refs.find((entry) => entry.startsWith("bead:"))?.slice(5);
  if (bead) out.bead = bead;
  const gh = refs.find((entry) => entry.startsWith("gh:"))?.match(/^gh:([^/]+)\/([^#]+)#(\d+)$/);
  if (gh) out.gh = { owner: gh[1], repo: gh[2], number: Number(gh[3]) };
  return out;
}

// Which beads already became objectives: bead id -> the objective carrying its
// `bead:` ref. An open objective wins over a closed one, so a bead promoted
// twice points at the live work.
export function promotedBeads(tickets: Ticket[]): Map<string, string> {
  const map = new Map<string, string>();
  const closedOnes = new Set<string>();
  for (const ticket of tickets) {
    const bead = ticketRefs(ticket).bead;
    if (!bead) continue;
    if (!map.has(bead) || (closedOnes.has(bead) && !isFinished(ticket))) {
      map.set(bead, ticket.id);
      if (isFinished(ticket)) closedOnes.add(bead);
      else closedOnes.delete(bead);
    }
  }
  return map;
}

export function githubIssueUrl(gh: { owner: string; repo: string; number: number }): string {
  return `https://github.com/${gh.owner}/${gh.repo}/issues/${gh.number}`;
}

// Objective order (owner spec), three groups top to bottom:
//   1. in progress, 2. the other open ones (open, held, blocked),
//   3. finished (closed done or skipped).
// A heading with an in-progress child counts as in progress. Groups 1 and 2
// sort by priority P0 to P4 (none counts as 5, after P4), then o-number, each
// dot-segment read as a number (o2 above o10). Group 3 sorts by when each was
// closed, newest first, and ignores priority and number; a finished ticket
// under an open heading still joins this group. A child orders the same way
// among its siblings and stays under its parent. Ties keep their recorded order.
export const NO_PRIORITY_BAND = 5;
// A read-only cut of the objectives, for the engine reading a seat's board.
// Priorities match the stored value, so "none" is its own entry and never
// counts as 0 to 2; owner-held is P3, P4 or none, derived, not a field.
export interface TicketFilter {
  statuses?: BoardStatus[];
  priorities?: Array<number | "none">;
}
// Open or in progress, P0 to P2: what a seat may pull without the owner.
export const READY_TO_PULL: TicketFilter = { statuses: ["open", "in_progress"], priorities: [0, 1, 2] };

// Whether full auto would pick this objective up (open or in progress, P0 to
// P2). A property of the objective, shown whether or not conn is on, and
// whether or not the board is held: a hold only pauses the pulling.
export function isAutoPullable(ticket: Ticket): boolean {
  return filterTickets([ticket], READY_TO_PULL).length === 1;
}

// Nothing left for a full-auto-clear conn to work: no objective in progress
// (at any priority) and no open P0 to P2. P3, P4 and no priority are owner-held.
export function boardIsClear(tickets: Ticket[]): boolean {
  return !tickets.some((ticket) => ticket.status === "in_progress" || (ticket.status === "open" && ticket.priority !== undefined && ticket.priority <= 2));
}

export function filterTickets(tickets: Ticket[], filter: TicketFilter): Ticket[] {
  return tickets.filter((ticket) =>
    (!filter.statuses || filter.statuses.includes(ticket.status))
    && (!filter.priorities || filter.priorities.includes(ticket.priority ?? "none")));
}

// What the priority card shows. An objective with no priority reads P5, but
// only on screen: the stored priority stays unset, so nothing can mistake it
// for P0 to P2 (the auto-backlog band).
export function displayPriority(ticket: Pick<Ticket, "priority">): number {
  return ticket.priority ?? NO_PRIORITY_BAND;
}
export function sortObjectives(tickets: Ticket[]): Ticket[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const live = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.status === "in_progress") for (const level of ancestry(ticket, byId)) live.add(level.id);
  }
  const group = (ticket: Ticket) => (isFinished(ticket) ? 2 : live.has(ticket.id) ? 0 : 1);
  // statusSince is the close event's own time on a closed ticket.
  const closedAt = (ticket: Ticket) => Date.parse(ticket.statusSince) || 0;
  const key = (ticket: Ticket): number[] => isFinished(ticket)
    ? [2, ...ancestry(ticket, byId).filter(isFinished).map((level) => -closedAt(level))]
    : ancestry(ticket, byId).flatMap((level) => [group(level), level.priority ?? NO_PRIORITY_BAND, Number(level.id.split(".").pop()!.replace(/\D/g, "") || 0)]);
  return [...tickets].sort((a, b) => {
    const left = key(a), right = key(b);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      // A parent's key is a prefix of its child's: the parent comes first.
      const l = left[index] ?? -Infinity, r = right[index] ?? -Infinity;
      if (l !== r) return l < r ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// The ticket and its parents, root first, by the `under` chain (a ticket can
// be moved under another, so the id is not the path). A parent missing from
// the list ends the chain; the guard stops a loop.
function ancestry(ticket: Ticket, byId: Map<string, Ticket>): Ticket[] {
  const chain = [ticket];
  for (let next = ticket.under ? byId.get(ticket.under) : undefined; next && chain.length < 64 && !chain.includes(next); next = next.under ? byId.get(next.under) : undefined) chain.unshift(next);
  return chain;
}

// How deep a ticket sits in the tree: one indent step per parent in its
// `under` chain.
// Des, 19 Oct: a ticket's note may open with GOAL: while the work is open, and
// its close note with RESULT: once it lands. Plain text in the same note — no
// field, no schema. The card shows the text; the label is stripped, because the
// card's own state already says which line this is.
export type LabeledLine = { label: "GOAL" | "RESULT"; text: string };

export function labeledLine(note: string | undefined): LabeledLine | null {
  const first = note?.trimStart().split("\n")[0]?.trim();
  const match = first ? /^(GOAL|RESULT):\s*(.*)$/i.exec(first) : null;
  if (!match) return null;
  const text = match[2].trim();
  return text ? { label: match[1].toUpperCase() as LabeledLine["label"], text } : null;
}

// Des, 19 Oct (o239/o52): the board's feed. NOW comes from board truth; the
// feed itself is the status changes as they happened, newest first, in two
// words only — Working when an objective starts, Completed when it lands.
// "Started" and "Working" are the same thing to Des, and adds and updates are
// noise. A label rides a row; it never decides whether the row appears.
export type FeedChange = { key: string; at: string; ticket: Ticket; what: "Working" | "Completed" };

const startOf = (ticket: Ticket) => ticket.startedAt ?? ticket.statusSince;

// The newest thing that happened to the objective: a status change, a stage or
// a note (Des, 19 Oct). The feed's clock is this, so live work bubbles up.
export function lastUpdate(ticket: Ticket): string {
  return ticket.history.reduce((latest, change) => (Date.parse(change.at) || 0) > (Date.parse(latest) || 0) ? change.at : latest, startOf(ticket));
}

export function liveObjectives(tickets: Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ticket.status === "in_progress")
    .sort((a, b) => (Date.parse(startOf(b)) || 0) - (Date.parse(startOf(a)) || 0));
}

export function finishedNewest(tickets: Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ticket.status === "closed")
    .sort((a, b) => (Date.parse(b.statusSince) || 0) - (Date.parse(a.statusSince) || 0));
}

export function objectiveFeed(tickets: Ticket[]): FeedChange[] {
  const entries: FeedChange[] = [];
  for (const ticket of tickets) {
    if (ticket.status !== "in_progress" && ticket.status !== "closed") continue;
    entries.push({ key: ticket.id, at: lastUpdate(ticket), ticket, what: ticket.status === "in_progress" ? "Working" : "Completed" });
  }
  return entries.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

// The note on the change that closed the ticket; the ticket's own note when the
// close carried none.
export function closingNote(ticket: Ticket): string | undefined {
  for (let index = ticket.history.length - 1; index >= 0; index--) {
    const change = ticket.history[index];
    if (change.status === "closed" && change.note) return change.note;
  }
  return ticket.note;
}

export function ticketDepth(ticket: Ticket, tickets: Ticket[]): number {
  return ancestry(ticket, new Map(tickets.map((entry) => [entry.id, entry]))).length - 1;
}

// The finished tickets (done or skipped) the panel folds into one row at the
// top, in plan order, so the work still ahead sits near the top. A ticket
// finished out of order folds too. A single one isn't worth a fold row. Once
// every ticket is finished nothing is ahead, and the whole list is the record
// of the run, so nothing folds.
// O3000 (o30): family grouping for the Beads view — a child renders inline
// under its epic, recursively (a child with its own children nests deeper).
// OWNER SPEC: all open beads band by priority — within a band the epics
// (families with children) come first, each followed by its children; the
// children ride their epic's band whatever their own pill says; then the
// band's parentless beads. A child attaches only when its epic is in the
// same slice (the bucket rule lives with the caller); an orphan — epic
// absent from the read — stays top-level, so no row ever drops or doubles.
export type NestedBead<T> = { issue: T; children: Array<NestedBead<T>> };
export function nestBeads<T extends { id: string; parent?: string; priority?: number }>(issues: T[]): Array<NestedBead<T>> {
  const entries = new Map<string, NestedBead<T>>();
  for (const issue of issues) entries.set(issue.id, { issue, children: [] });
  const tops: Array<NestedBead<T>> = [];
  for (const issue of issues) {
    const parent = issue.parent && issue.parent !== issue.id ? entries.get(issue.parent) : undefined;
    if (parent) parent.children.push(entries.get(issue.id)!);
    else tops.push(entries.get(issue.id)!);
  }
  const band = (entry: NestedBead<T>) => entry.issue.priority ?? 9;
  const order = (list: Array<NestedBead<T>>): Array<NestedBead<T>> => {
    // Stable sort: ties keep the caller's order (compareBeads). Epics first
    // inside a band, so a sprint leads its own children and the strays.
    list.sort((a, b) => (band(a) !== band(b) ? band(a) - band(b) : a.children.length && !b.children.length ? -1 : !a.children.length && b.children.length ? 1 : 0));
    list.forEach((entry) => order(entry.children));
    return list;
  };
  return order(tops);
}

export function finishedToFold(tickets: Ticket[]): Ticket[] {
  const finished = tickets.filter(isFinished);
  return finished.length >= 2 && finished.length < tickets.length ? finished : [];
}

// What the objectives list shows in place and what folds behind the count
// row. A finished ticket the fold doesn't take (a lone one, or every ticket on
// a finished board) stays listed in plan order, never dropped.
export function splitFinished(tickets: Ticket[]): { listed: Ticket[]; folded: Ticket[] } {
  const folded = finishedToFold(tickets);
  const taken = new Set(folded);
  return { listed: tickets.filter((ticket) => !taken.has(ticket)), folded };
}

// The board-name line's indicator: what the whole board is doing, as up to two
// counted statuses. Idle only when nothing is moving or stuck. Stale means
// in-progress work with no update (a running agent keeps it active); a board
// with nothing in progress cannot be stale. The reasons ride the objective rows.
export type Indicator =
  | { kind: "idle" }
  | { kind: "active" | "stale" | "stuck"; count: number };

// Des, 16 Oct: "Stucks are only 0/1/2s and active or fullauto." A stuck item
// counts only when its objective is P0 to P2, and only on a board that has work
// in progress or a full auto on. A flag with no objective behind it has no
// priority, so it does not count.
// Des, 19 Oct: only P0 to P2 objectives can be stuck. P3, P4 and none are
// backlog, not live work, so a blocked P4 is not a warning anywhere.
export function openChildren(dashboard: Pick<Dashboard, "tickets">, id: string): Ticket[] {
  return dashboard.tickets.filter((ticket) => ticket.under === id && ticket.status !== "closed");
}

export function owedStuck(stuck: StuckItem[], tickets: Ticket[]): StuckItem[] {
  return stuck.filter((item) => {
    const priority = item.ticketId === undefined ? undefined : tickets.find((ticket) => ticket.id === item.ticketId)?.priority;
    return priority !== undefined && priority <= 2;
  });
}

export function boardStatuses(board: Pick<Dashboard, "tickets" | "stuck" | "stale"> & { conn?: unknown }, agentRunning: boolean): Indicator[] {
  // A parent is worked through its live child, so count only the deepest live
  // objective in each chain: two live siblings are two goals, a parent and its
  // one live child are one, at any depth (Des, 18 Oct).
  const byId = new Map(board.tickets.map((ticket) => [ticket.id, ticket]));
  const inProgress = board.tickets.filter((ticket) => ticket.status === "in_progress");
  const covered = new Set(inProgress.flatMap((ticket) => ancestry(ticket, byId).slice(0, -1).map((level) => level.id)));
  const working = inProgress.filter((ticket) => !covered.has(ticket.id)).length;
  const live = working > 0 || Boolean(board.conn);
  const stuck = live ? owedStuck(board.stuck, board.tickets).length : 0;
  const statuses: Indicator[] = [];
  if (working) statuses.push({ kind: board.stale && !agentRunning ? "stale" : "active", count: working });
  if (stuck) statuses.push({ kind: "stuck", count: stuck });
  return statuses.length ? statuses : [{ kind: "idle" }];
}

// The icon beside the ticker line follows the same statuses as the indicator:
// a spinner only while work is active, the stalled warning only when in-progress
// work has stalled, and a still dot when nothing is running (stuck alone is the
// indicator's job). A finished board shows the check.
export type TickerIcon = "finished" | "live" | "stale" | "idle";
export function tickerIcon(statuses: Indicator[], finished: boolean): TickerIcon {
  if (finished) return "finished";
  if (statuses.some((status) => status.kind === "stale")) return "stale";
  if (statuses.some((status) => status.kind === "active")) return "live";
  return "idle";
}

// The hold sign in the panel header, beside the conn sign: which hold it is,
// and (on hover) what it means for the work.
export function holdLabel(hold: Hold): string {
  return hold.kind === "closed" ? "⏸️ Closed" : "⏸️ Speccing";
}

export function holdHover(hold: Hold): string {
  const meaning = hold.kind === "closed"
    ? "Board on hold: closed to work, items can still be added"
    : "Board on hold: speccing with the owner here, items can still be added and no work starts";
  return hold.note ? `${meaning}. ${hold.note}` : meaning;
}

// The conn sign in the panel header. Solid only while the engine says live AND
// it is still inside its window: the DCI engine rewrites nextNudgeAt on every
// nudge, so a time more than CONN_GRACE_MIN past it means the engine went quiet
// and the sign dims rather than claim live work. Keepalive is never solid.
export const CONN_GRACE_MIN = 5;
export function connDisplay(conn: Conn, nowMs: number): { solid: boolean; hover: string } {
  const due = Date.parse(conn.nextNudgeAt);
  const solid = conn.mode === "live" && nowMs <= due + CONN_GRACE_MIN * 60_000;
  const next = Number.isNaN(due) ? "unknown" : new Date(due).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const state = conn.mode === "keepalive" ? "keep-alive pending" : solid ? "work outstanding" : "engine quiet past its nudge";
  return { solid, hover: `Conn on, budget ${conn.budget}${conn.clear ? ", until board autos cleared" : ""}, ${state}, next nudge ${next}` };
}

// The header text before the board name: the infinity sign and the FM budget,
// then a chequered flag only for full auto clear (it ends when the board is clear).
export function connLabel(conn: Conn): string {
  return `♾️(${conn.budget})${conn.clear ? " 🏁" : ""}`;
}

// The indicator's word: "Idle", or the kind with its count, like "Stuck 2".
export function indicatorLabel(status: Indicator): string {
  return status.kind === "idle" ? "Idle" : `${status.kind[0].toUpperCase()}${status.kind.slice(1)} ${status.count}`;
}

export function isFinished(ticket: Ticket): boolean {
  return ticket.status === "closed";
}

// ── One shared list (O2600 / o17) ──────────────────────────────────
// The three panel views (objectives, beads, GH issues) render through one
// list, one row style, one done-sink. These are the pure pieces the tree
// tests pin; the panel glue is typed by typecheck.

// Running vs potential: only work in progress runs full-strength; everything
// else sits muted (75%), so the eye splits the work that is happening from
// the work that is queued. Blocked and deferred count as potential: not running.
export type RowTone = "running" | "potential";
export function rowTone(status: string): RowTone {
  return status === "in_progress" ? "running" : "potential";
}

// The bead fields the shared list needs — structural, so callers pass the
// rpc's BeadIssue as-is and tests need no rpc import.
export interface BeadLike {
  id: string;
  title: string;
  status: string;
  priority?: number;
  close_reason?: string;
}

// Bead order in the shared list: open first (closed sink below, like the
// objectives' done-sink), then priority 0 (most urgent) to 4, no priority
// last, then id, so the read is stable.
export function compareBeads(a: BeadLike, b: BeadLike): number {
  const sunk = (bead: BeadLike) => (bead.status === "closed" ? 1 : 0);
  if (sunk(a) !== sunk(b)) return sunk(a) - sunk(b);
  const order = (a.priority ?? 9) - (b.priority ?? 9);
  if (order) return order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// The closed beads the shared list folds behind the count header — the same
// rule the objectives' fold uses: two or more closed and open work remains.
// When everything is closed the whole list is the record and nothing folds.
export function beadsToFold(issues: BeadLike[]): BeadLike[] {
  const closed = issues.filter((bead) => bead.status === "closed");
  return closed.length >= 2 && closed.length < issues.length ? closed : [];
}

// The fold's count label: "2 done", "1 done, 1 skipped". A closed bead
// without a recorded reason reads as done.
export function beadDoneLabel(closed: BeadLike[]): string {
  const skipped = closed.filter((bead) => bead.close_reason === "skipped").length;
  const done = closed.length - skipped;
  return [done ? `${done} done` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean).join(", ");
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function headline(tickets: Ticket[], itemLabel: string, waiting: number, stuck: number): HeadlinePart[] {
  const counted = tickets.filter((ticket) => !(ticket.status === "closed" && ticket.closeReason === "skipped"));
  const done = counted.filter((ticket) => ticket.status === "closed").length;
  const parts: HeadlinePart[] = [{ text: `${done} of ${plural(counted.length, itemLabel.toLowerCase())} done`, tone: "normal" }];
  if (waiting) parts.push({ text: `${plural(waiting, "question")} waiting for you`, tone: "normal" });
  if (stuck) parts.push({ text: `${stuck} stuck`, tone: "danger" });
  return parts;
}

export function headlineText(dashboard: Dashboard): string {
  return dashboard.headline.map((part) => part.text).join(", ");
}

function nextId(prefix: string, used: Iterable<string>, width = 2): string {
  let max = 0;
  for (const id of used) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

export const EMPTY_DASHBOARD: Dashboard = {
  run: null,
  updatedAt: null,
  stale: false,
  headline: [],
  stuck: [],
  questions: { open: [], answered: [] },
  deliverables: [],
  activity: [],
  ticker: null,
  progress: { percent: 0, doneMin: 0, totalMin: 0, segments: [] },
  tickets: [],
  issues: [],
};
