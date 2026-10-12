import { EVENT_VERSION, eventSchema, type DELIVERABLE_KINDS, type FileLink, type ProgressEvent, type QuestionOption, type TicketStatus } from "./events.ts";

// One recorded change to a ticket, oldest first. `stage: ""` clears the stage.
export interface TicketChange {
  at: string;
  status?: TicketStatus;
  stage?: string;
  note?: string;
}

export interface Ticket {
  id: string;
  title: string;
  estimateMin: number;
  status: TicketStatus;
  // When the ticket entered its current status.
  statusSince: string;
  // When the ticket last started working.
  workingSince?: string;
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
  // The Paseo agent that last added or updated it, when written from Paseo.
  agentId?: string;
  // The ticket's owning workspace, so a union board can tell two scopes'
  // same-minted ids apart.
  ws?: string;
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
  return ticket.status === "done" || ticket.status === "skipped";
}

// The union scope: All folds every scope's current run together into one
// board (owner union, revision 5). Distinct from undefined, which stays the
// unscoped 0.4.0 latest-run fold.
export const UNION_SCOPE = "*";

// The events from the last `run.start` on; earlier runs are ignored.
export function latestRun(events: ParsedLine[]): ParsedLine[] {
  const start = events.findLastIndex(({ event }) => event.type === "run.start");
  return events.slice(Math.max(start, 0));
}

// The events one workspace's scope shows, so two workspaces on one checkout
// stop evicting each other. Two choices, separate on purpose:
// - Run-slot: with a scope, the boundary is the last `run.start` carrying that
//   `ws`; an unscoped start claims the slot only in a scope that has no scoped
//   start of its own. With no scope, the boundary is the last `run.start` in
//   the file, exactly as 0.4.0 did it.
// - Content: inside the selected run, an event with no `ws` stays visible in
//   every scope, so legacy events and unscoped writers are never filtered
//   away — except an unscoped `run.start`, which claims no header in a scope
//   with a run of its own (proof fix D-1).
export function scopeEvents(events: ParsedLine[], scope?: string): ParsedLine[] {
  if (scope === UNION_SCOPE) return unionEvents(events);
  if (scope === undefined) return latestRun(events);
  let start = events.findLastIndex(({ event }) => event.type === "run.start" && event.ws === scope);
  const ownRun = start >= 0;
  if (!ownRun) start = events.findLastIndex(({ event }) => event.type === "run.start" && event.ws === undefined);
  // This workspace has never started a run here, so it sees nothing. Without
  // this, `Math.max(start, 0)` slices from the top of the file and hands the
  // scope another workspace's stray unscoped events.
  if (start < 0) return [];
  return events.slice(start).filter(({ event }) =>
    event.ws === scope || (event.ws === undefined && !(ownRun && event.type === "run.start")));
}

// The union fold: every scope's current run, each event once, in file order —
// one board with both runs' tickets (owner union, revision 5). Unscoped
// events shared by two scoped runs appear once. A file with no workspace
// events folds exactly as 0.4.0 did.
function unionEvents(events: ParsedLine[]): ParsedLine[] {
  const scopes = new Set(events.flatMap(({ event }) => (event.type === "run.start" && event.ws !== undefined ? [event.ws] : [])));
  if (scopes.size === 0) return latestRun(events);
  const seen = new Set<number>();
  const union: ParsedLine[] = [];
  for (const scope of scopes) {
    for (const parsed of scopeEvents(events, scope)) {
      if (seen.has(parsed.line)) continue;
      seen.add(parsed.line);
      // Tag each line with the slice it came from, so the union keys by the
      // run's scope, not by each event's own ws (proof fix D-2).
      union.push({ ...parsed, foldScope: scope });
    }
  }
  return union.sort((a, b) => a.line - b.line);
}

// Folds the events of the latest run into what the panel shows at `now`, how
// long that stays true while the events don't change, and the ids new items get.
// Everything before the last `run.start` belongs to earlier runs and is ignored.
export function reduceProgress(parsed: { events: ParsedLine[]; issues: FileIssue[] }, now: Date, scope?: string): { dashboard: Dashboard; validUntil: number; nextIds: NextIds } {
  const time = clock(now);
  const events = scopeEvents(parsed.events, scope);
  // In the union fold, ids minted per scope may repeat, so every id is keyed
  // by its run's scope ("" for legacy events) and the ticket carries that
  // scope as its ws. One board, both T01s.
  const union = scope === UNION_SCOPE;
  const key = (ws: string | undefined, id: string) => (union ? `${ws ?? ""}/${id}` : id);
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
  const manualStuck = new Map<string, { id: string; reason: string; ticket?: string; since: string }>();
  let updatedAt: string | null = null;

  for (const parsed of events) {
    const { line, event } = parsed;
    // In the union fold a run's continuation is that run whatever ws later
    // events carry, so every id is keyed by the slice's scope, not the
    // event's own ws (proof fix D-2). Outside the union, the event's own ws.
    const wsKey = union ? parsed.foldScope : event.ws;
    updatedAt = event.ts;
    switch (event.type) {
      case "run.start":
        run = { title: event.title, subtitle: event.subtitle, itemLabel: event.itemLabel ?? "Ticket", startedAt: event.ts };
        break;
      case "run.finish":
        if (run) run.finished = { at: event.ts, outcome: event.outcome };
        ticker = null;
        break;
      case "ticket.add": {
        const k = key(wsKey, event.id);
        // D-4 (O1000): an unscoped writer's add must not take a scoped
        // ticket's place (design A.5, owner ruling). Nothing scoped is ever
        // minted in a file with no ws events, so such a file folds exactly as
        // 0.4.0 did; a no-ws ticket.update still reaches the scoped ticket.
        if (scopedMints.has(k) && event.ws === undefined) break;
        if (event.ws !== undefined) scopedMints.add(k);
        tickets.set(k, {
          id: event.id,
          title: event.title,
          estimateMin: event.estimateMin,
          status: event.status ?? "not_started",
          statusSince: event.ts,
          workingSince: event.status === "working" ? event.ts : undefined,
          history: [{ at: event.ts, status: event.status ?? "not_started" }],
          waitsFor: event.waitsFor,
          source: event.source,
          ref: event.ref,
          ws: wsKey,
          agentId: event.by,
        });
        break;
      }
      case "ticket.update": {
        const ticket = tickets.get(key(wsKey, event.id));
        if (!ticket) {
          issues.push({ line, reason: `unknown ticket ${event.id}` });
          break;
        }
        if (event.title !== undefined) ticket.title = event.title;
        if (event.estimateMin !== undefined) ticket.estimateMin = event.estimateMin;
        const change: TicketChange = { at: event.ts };
        if (event.status !== undefined && event.status !== ticket.status) change.status = event.status;
        if (event.stage !== undefined && event.stage !== (ticket.stage ?? "")) change.stage = event.stage;
        if (event.note) change.note = event.note;
        if (Object.keys(change).length > 1) ticket.history.push(change);
        if (event.status !== undefined && event.status !== ticket.status) {
          ticket.status = event.status;
          ticket.statusSince = event.ts;
          if (event.status === "working") ticket.workingSince = event.ts;
        }
        if (event.stage !== undefined && event.stage !== (ticket.stage ?? "")) {
          ticket.stage = event.stage || undefined;
          ticket.stageSince = event.stage ? event.ts : undefined;
        }
        if (event.note !== undefined) ticket.note = event.note || undefined;
        if (event.waitsFor !== undefined) ticket.waitsFor = event.waitsFor || undefined;
        if (event.source !== undefined) ticket.source = event.source || undefined;
        if (event.ref !== undefined) ticket.ref = event.ref;
        if (union) ticket.ws = wsKey;
        else if (event.ws !== undefined) ticket.ws = event.ws;
        if (event.by) ticket.agentId = event.by;
        break;
      }
      case "ticket.remove": {
        const k = key(wsKey, event.id);
        if (tickets.delete(k)) scopedMints.delete(k);
        else issues.push({ line, reason: `unknown ticket ${event.id}` });
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
          ticketId: event.ticket,
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
          ticketId: event.ticket,
          kind: event.kind,
          addedAt: event.ts,
        });
        break;
      case "deliverable.remove":
        if (!deliverables.delete(key(wsKey, event.id))) issues.push({ line, reason: `unknown deliverable ${event.id}` });
        break;
      case "activity.add":
        activity.set(key(wsKey, event.id), { id: event.id, text: event.text, ticketId: event.ticket, at: event.ts });
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
      case "stuck.set":
        manualStuck.set(key(wsKey, event.id), { id: event.id, reason: event.reason, ticket: event.ticket, since: event.ts });
        break;
      case "stuck.clear":
        if (!manualStuck.delete(key(wsKey, event.id))) issues.push({ line, reason: `unknown stuck item ${event.id}` });
        break;
    }
  }

  const list = [...tickets.values()];
  for (const ticket of list) {
    const other = ticket.waitsFor ? tickets.get(key(ticket.ws, ticket.waitsFor)) : undefined;
    ticket.waitingFor = other && !isSettled(other) && !isSettled(ticket)
      ? { id: other.id, title: other.title }
      : undefined;
  }
  const itemLabel = run?.itemLabel ?? "Ticket";
  const stuck = stuckItems(list, [...activity.values()], [...manualStuck.values()], time.reached);
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
    headline: headline(list, itemLabel, open.length, stuck.length),
    stuck,
    questions: { open, answered },
    activity: [...activity.values()].reverse(),
    ticker,
    deliverables: [...deliverables.values()].reverse().map((deliverable) => {
      const ticket = deliverable.ticketId ? tickets.get(deliverable.ticketId) : undefined;
      return ticket ? { ...deliverable, ticketLabel: shortTitle(ticket.title) } : deliverable;
    }),
    progress: progress(list, run?.startedAt),
    tickets: list,
    issues: issues.sort((a, b) => a.line - b.line),
  };
  return { dashboard, validUntil: time.validUntil, nextIds: nextIds(parsed.events.map(({ event }) => event), events.map(({ event }) => event)) };
}

function nextIds(all: ProgressEvent[], inRun: ProgressEvent[]): NextIds {
  const used = (events: ProgressEvent[], type: ProgressEvent["type"]) => events.flatMap((event) => (event.type === type && "id" in event ? [event.id] : []));
  return {
    ticket: nextId("T", used(inRun, "ticket.add")),
    question: nextId("Q", used(all, "question.ask"), 1),
    deliverable: nextId("D", used(inRun, "deliverable.add"), 1),
    activity: nextId("A", used(inRun, "activity.add"), 1),
    stuck: nextId("S", used(inRun, "stuck.set"), 1),
  };
}

function progress(tickets: Ticket[], startedAt: string | undefined): Dashboard["progress"] {
  const counted = tickets.filter((ticket) => ticket.status !== "skipped");
  const totalMin = counted.reduce((sum, ticket) => sum + ticket.estimateMin, 0);
  const doneMin = counted.filter((ticket) => ticket.status === "done").reduce((sum, ticket) => sum + ticket.estimateMin, 0);
  // All done: the last ticket to settle, done or skipped, ended the work.
  const allDone = counted.length > 0 && counted.every((ticket) => ticket.status === "done") && tickets.every(isSettled);
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

function stuckItems(tickets: Ticket[], activity: Activity[], manual: Array<{ id: string; reason: string; ticket?: string; since: string }>, reached: (at: number) => boolean): StuckItem[] {
  const items: StuckItem[] = [];
  for (const ticket of tickets) {
    // Blocked only on another ticket in the run is waiting, not stuck.
    if (ticket.status === "blocked" && !ticket.waitingFor) {
      items.push({ kind: "blocked", key: `blocked:${ticket.id}`, ticketId: ticket.id, title: ticket.title, since: ticket.statusSince, note: ticket.note });
    } else if (ticket.status === "working") {
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
    const ticket = item.ticket ? tickets.find((candidate) => candidate.id === item.ticket) : undefined;
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

// The finished tickets (done or skipped) the panel folds into one row at the
// top, in plan order, so the work still ahead sits near the top. A ticket
// finished out of order folds too. A single one isn't worth a fold row. Once
// every ticket is finished nothing is ahead, and the whole list is the record
// of the run, so nothing folds.
export function finishedToFold(tickets: Ticket[]): Ticket[] {
  const finished = tickets.filter(isFinished);
  return finished.length >= 2 && finished.length < tickets.length ? finished : [];
}

export function isFinished(ticket: Ticket): boolean {
  return ticket.status === "done" || ticket.status === "skipped";
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function headline(tickets: Ticket[], itemLabel: string, waiting: number, stuck: number): HeadlinePart[] {
  const counted = tickets.filter((ticket) => ticket.status !== "skipped");
  const done = counted.filter((ticket) => ticket.status === "done").length;
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
