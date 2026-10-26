// The command agents run to record progress. Each command appends one event
// to the worktree's progress file and prints what it recorded.
import { realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openChildren, boardIsClear, boardStatuses, filterTickets, indicatorLabel, isSettled, READY_TO_PULL, type TicketFilter, displayId, ticketName, type Dashboard, type NextIds, type Ticket } from "../shared/dashboard.ts";
import { CLOSE_REASONS, CONN_MODES, DELIVERABLE_KINDS, HOLD_KINDS, type BoardStatus, type CloseReason, type ConnMode, type FileLink, type HoldKind, type ProgressEvent } from "../shared/events.ts";
import { appendProgress, InvalidEvent, readLatestRun, readProgress, type EventDraft } from "./progress-file.ts";
import { findRoot, outside } from "./paths.ts";
import { resolveWorkspaceId } from "./workspace.ts";
import { UNION_SCOPE } from "../shared/dashboard.ts";
import { installLaunchers } from "./launcher.ts";
import { closeBackingBeads } from "./beads.ts";
import { findStore, outsideDirectory, restoreState, saveRunCopy } from "./store.ts";
import { dashboardText, ticketLines } from "../shared/show.ts";
import { imageMimeType } from "../shared/attachments.ts";
import { homedir } from "node:os";

export interface CliOptions {
  cwd: string;
  now?: () => Date;
  out?: (line: string) => void;
  // The Paseo agent running the command, recorded on each event it writes.
  agentId?: string;
  // The workspace the command is for, when the caller knows it (the panel's
  // own buttons); wins over the agent's registry record.
  workspaceId?: string;
}

class UsageError extends Error {}

interface State {
  dashboard: Dashboard;
  nextIds: NextIds;
  // The run's events as the fold saw them, for id minting that never reuses a number.
  events: ProgressEvent[];
}

interface Command {
  usage: string;
  summary: string;
  options?: Record<string, { type: "string" | "boolean"; multiple?: boolean }>;
  run(args: { positionals: string[]; values: Record<string, string | boolean | Array<string | boolean> | undefined>; state: State; cwd: string; root: string; scope?: string }): { event: EventDraft; message: string };
}

const USAGE_NAME = "paseo-progress";

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new UsageError(`Missing ${name}.`);
  return value.trim();
}

function minutesOption(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new UsageError(`--${name} must be a whole number of minutes, like 90.`);
  return number;
}

// The words the CLI accepts: the Beads vocabulary, plus the 0.4.0 aliases,
// which are written canonically so the file speaks one language.
const STATUS_WORDS: Record<string, { status: BoardStatus; closeReason?: CloseReason }> = {
  open: { status: "open" },
  in_progress: { status: "in_progress" },
  blocked: { status: "blocked" },
  closed: { status: "closed" },
  not_started: { status: "open" },
  working: { status: "in_progress" },
  done: { status: "closed", closeReason: "done" },
  skipped: { status: "closed", closeReason: "skipped" },
};

function statusOption(value: unknown) {
  if (value === undefined) return undefined;
  const status = STATUS_WORDS[String(value).replace(/-/g, "_")];
  if (!status) throw new UsageError(`--status must be one of: ${Object.keys(STATUS_WORDS).slice(0, 4).join(", ")}.`);
  return status;
}

function closeReasonOption(value: unknown): CloseReason | undefined {
  if (value === undefined) return undefined;
  const reason = String(value);
  if (!(CLOSE_REASONS as readonly string[]).includes(reason)) {
    throw new UsageError(`--close-reason must be one of: ${CLOSE_REASONS.join(", ")}.`);
  }
  return reason as CloseReason;
}

function priorityOption(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 4) throw new UsageError("--priority must be a number from 0 to 4.");
  return number;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function listOption(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// "A=Even out the spacing | Cards look balanced" → letter, label, consequence.
function parseOption(raw: string) {
  const match = /^\s*([A-Za-z])\s*=\s*(.+)$/.exec(raw);
  if (!match) throw new UsageError(`--option must look like "A=<label> | <consequence>", got "${raw}".`);
  const [label, ...rest] = match[2].split("|").map((part) => part.trim());
  if (!label) throw new UsageError(`--option ${match[1].toUpperCase()} needs a label.`);
  return { letter: match[1].toUpperCase(), label, consequence: rest.join(" | ") || undefined };
}

const URL_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

// "path/to/file.png=Before and after" → root-relative path and optional label.
// "https://example.com/?q=1=Preview" → URL and label: an "=" right after a
// query key belongs to the URL.
function parseFile(raw: string, cwd: string, root: string) {
  const isUrl = URL_PATTERN.test(raw);
  let index = isUrl ? raw.lastIndexOf("=") : raw.indexOf("=");
  while (isUrl && index !== -1 && /[?&][^=&#]*$/.test(raw.slice(0, index))) index = raw.lastIndexOf("=", index - 1);
  const target = (index === -1 ? raw : raw.slice(0, index)).trim();
  const label = index === -1 ? undefined : raw.slice(index + 1).trim() || undefined;
  if (!target) throw new UsageError(`--file needs a path or URL, got "${raw}".`);
  if (!isUrl) return { path: rootRelative(target, cwd, root), label };
  if (!/^https?:\/\//i.test(target)) throw new UsageError("Only http(s) URLs are supported; give local files as a path.");
  return { url: target, label };
}

function existingActivity(state: State, id: string | undefined) {
  const wanted = required(id, "activity id").toUpperCase();
  const entry = state.dashboard.activity.find((candidate) => candidate.id === wanted);
  if (!entry) {
    const known = state.dashboard.activity.map((candidate) => candidate.id).join(", ") || "none";
    throw new UsageError(`No activity ${wanted} in this run. Activity: ${known}.`);
  }
  return entry;
}

function existingQuestion(state: State, id: string | undefined) {
  const wanted = required(id, "question id").toUpperCase();
  const { open, answered } = state.dashboard.questions;
  const question = [...open, ...answered].find((candidate) => candidate.id === wanted);
  if (!question) {
    const known = [...open, ...answered].map((candidate) => candidate.id).join(", ") || "none";
    throw new UsageError(`No question ${wanted} in this run. Questions: ${known}.`);
  }
  return question;
}

function existingTicket(state: State, id: string | undefined) {
  // Tickets answer to their o-id and, through the migration, their legacy
  // T-id: "T07" and "o7" name the same ticket.
  const wanted = displayId(required(id, "ticket id")).toLowerCase();
  const ticket = state.dashboard.tickets.find((candidate) => candidate.id.toLowerCase() === wanted);
  if (!ticket) {
    const known = state.dashboard.tickets.map((candidate) => candidate.id).join(", ") || "none";
    throw new UsageError(`No ticket ${wanted} in this run. Tickets: ${known}.`);
  }
  return ticket;
}

// The refs a command carries: repeatable --ref values, each like
// `bead:<id>`, `gh:<owner>/<repo>#<n>` or `teams:<messageId>`.
function refsOption(values: Record<string, string | boolean | Array<string | boolean> | undefined>): string[] | undefined {
  if (values.ref === undefined) return undefined;
  const refs = listOption(values.ref).map((entry) => String(entry).trim()).filter(Boolean);
  if (!refs.length) throw new UsageError("Missing --ref.");
  return refs;
}

// The next child id under one parent: the parent's path plus the position
// after the highest sibling ever added. Numbers are never reused, even after
// a remove, so the count runs over the run's events, not the live board.
function nextChildId(events: ProgressEvent[], parentPath: string): string {
  let max = 0;
  for (const event of events) {
    if (event.type !== "ticket.add" || event.under === undefined) continue;
    if (displayId(event.under) !== parentPath) continue;
    const id = displayId(event.id);
    if (!id.startsWith(`${parentPath}.`)) continue;
    const segment = Number(id.slice(parentPath.length + 1));
    if (Number.isInteger(segment)) max = Math.max(max, segment);
  }
  return `${parentPath}.${max + 1}`;
}

// What still has to be settled before a run can finish.
function unfinishedWork(dashboard: Dashboard): string[] {
  const label = (dashboard.run?.itemLabel ?? "Objective").toLowerCase();
  const tickets = dashboard.tickets.filter((ticket) => !isSettled(ticket));
  const flagged = dashboard.stuck.filter((item) => item.kind === "manual");
  return [
    dashboard.questions.open.length
      ? `open questions ${dashboard.questions.open.map((question) => question.id).join(", ")} (record the answer with "question answer", or withdraw with "question remove")`
      : "",
    tickets.length ? `${label}s not done or skipped: ${tickets.map((ticket) => ticket.id).join(", ")}` : "",
    flagged.length ? `flagged blockers ${flagged.map((item) => item.id).join(", ")} (clear with "stuck clear")` : "",
  ].filter(Boolean);
}

// Tickets another session added since this agent last wrote to the run, still
// to do. Nothing until the agent has written to the run: it reads `show` first.
function addedByOthers(events: ProgressEvent[], dashboard: Dashboard, agentId: string | undefined): Ticket[] {
  if (!agentId) return [];
  const since = events.findLastIndex((event) => event.by === agentId);
  if (since === -1) return [];
  // Event ids go through the migration, so a legacy writer's T02 matches the
  // board's o2.
  const added = new Set(events.slice(since + 1).flatMap((event) => (event.type === "ticket.add" && event.by !== agentId ? [displayId(event.id)] : [])));
  return dashboard.tickets.filter((ticket) => added.has(ticket.id) && !isSettled(ticket));
}

function addedByOthersText(tickets: Ticket[], dashboard: Dashboard): string {
  if (!tickets.length) return "";
  const label = (dashboard.run?.itemLabel ?? "Objective").toLowerCase();
  const one = tickets.length === 1;
  // Starts with a blank line, to follow the command's own output.
  return [
    "",
    "",
    `Another session added ${one ? `${/^[aeiou]/.test(label) ? "an" : "a"} ${label}` : `${tickets.length} ${label}s`} since your last update:`,
    ...tickets.map((ticket) => `  ${ticket.id}  ${ticket.title}`),
    // Awareness only: another agent's ticket is not an order to this one.
    `${one ? "It is" : "They are"} not an order: take ${one ? "it" : "them"} only if your task names ${one ? "it" : "them"}.`,
  ].join("\n");
}

const commands: Record<string, Command> = {
  start: {
    usage: `start "<title>" [--subtitle <text>] [--item-label <word>] [--replace]`,
    summary: "Create the workspace's board. It only works where no board exists yet: a board is one persistent object per workspace, so work the current one (show) and rename it (rename) when the theme changes. --replace is the deliberate override: it retires the current board, saying how many open objectives leave the dashboard (they stay in the file).",
    options: { subtitle: { type: "string" }, "item-label": { type: "string" }, replace: { type: "boolean" } },
    run({ positionals, values, state }) {
      const title = required(positionals[0], "run title");
      const current = state.dashboard.run;
      const open = state.dashboard.tickets.filter((ticket) => ticket.status !== "closed").length;
      if (current && !values.replace) {
        throw new UsageError(`This workspace already has a board: "${current.title}"${current.finished ? " (finished)" : ""}. A board is one persistent object per workspace: run ${USAGE_NAME} show and work it, and rename it with ${USAGE_NAME} rename "<title>" when the theme changes. start is only for a workspace that has never had a board. To retire this board on purpose, pass --replace${open ? `; ${open} open ${open === 1 ? "objective" : "objectives"} would leave the dashboard` : ""}.`);
      }
      const replaced = current ? `. Replaced the board "${current.title}": ${open} open ${open === 1 ? "objective leaves" : "objectives leave"} the dashboard (still in the file).` : "";
      return {
        event: { type: "run.start", title, subtitle: stringOption(values.subtitle), itemLabel: stringOption(values["item-label"]) },
        message: `Started run: ${title}${replaced}`,
      };
    },
  },
  finish: {
    usage: `finish "<outcome>"`,
    summary: "Close the run with a one-line outcome. Every ticket must be done or skipped, no question open, nothing flagged stuck. New work after this needs start --replace.",
    run({ positionals, state }) {
      const outcome = required(positionals[0], "outcome");
      if (!state.dashboard.run) throw new UsageError("No run to finish.");
      const left = unfinishedWork(state.dashboard);
      if (left.length) throw new UsageError(`Can't finish yet. Still open: ${left.join("; ")}.`);
      return { event: { type: "run.finish", outcome }, message: `Finished run: ${state.dashboard.run.title}` };
    },
  },
  rename: {
    usage: `rename ["<title>"] [--subtitle <text>]`,
    summary: `Rename the board: change the run's title and/or subtitle ("" clears the subtitle). Works on a finished run too. Ids, objectives and history stay as they are.`,
    options: { subtitle: { type: "string" } },
    run({ positionals, values, state }) {
      if (!state.dashboard.run) throw new UsageError("No run to rename.");
      const title = positionals[0] === undefined ? undefined : required(positionals[0], "run title");
      const subtitle = values.subtitle === undefined ? undefined : String(values.subtitle).trim();
      if (title === undefined && subtitle === undefined) throw new UsageError("Nothing to change. Pass a new title, --subtitle, or both.");
      const parts = [title === undefined ? "" : `Renamed the board to: ${title}`, subtitle === undefined ? "" : subtitle ? `subtitle: ${subtitle}` : "subtitle cleared"].filter(Boolean);
      return { event: { type: "run.rename", title, subtitle }, message: parts.join(", ") };
    },
  },
  "ticket add": {
    usage: `ticket add "<title>" --estimate <minutes> [--under <id>] [--status <status>] [--priority <0-4>] [--close-reason <done|skipped>] [--waits-for <id>] [--source <path or http(s) URL>[=<label>]] [--ref <ref> ...]`,
    summary: `Add a ticket. Prints its id (o1, o2, ...). --under nests it as the next child of another ticket, any depth (o1.1, o1.1.2). Statuses: open, in_progress, blocked, closed, with --close-reason done|skipped when closing. --priority is how urgent it is, 0-4; a child added with --under and no --priority takes its parent's priority when that is P0, P1 or P2 (only those are pulled to run), and the output says so. --waits-for names a ticket it can't start before; that is the order of work, not a blocker. --source is where the ticket is written up, like its spec file or issue link. --ref is where the work came from, like bead:<id>, gh:<owner>/<repo>#<n> or teams:<messageId>; repeat it to link more than one, and the name composes from the links.`,
    options: { estimate: { type: "string" }, under: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, "close-reason": { type: "string" }, "waits-for": { type: "string" }, source: { type: "string" }, ref: { type: "string", multiple: true } },
    run({ positionals, values, state, cwd, root }) {
      const waitsFor = values["waits-for"] === undefined ? undefined : existingTicket(state, stringOption(values["waits-for"])).id;
      const title = required(positionals[0], "ticket title");
      const estimateMin = minutesOption(values.estimate, "estimate");
      if (estimateMin === undefined) throw new UsageError("Missing --estimate <minutes>.");
      const source = values.source === undefined ? undefined : parseFile(String(values.source), cwd, root);
      const refs = refsOption(values);
      const parent = values.under === undefined ? undefined : existingTicket(state, stringOption(values.under));
      const under = parent?.id;
      const id = under ? nextChildId(state.events, under) : state.nextIds.ticket;
      const status = statusOption(values.status);
      // Des's rule: only P0-P2 are pulled to run, so a child with no priority of its own takes a P0-P2 parent's. An explicit --priority wins.
      const explicit = priorityOption(values.priority);
      const inherited = explicit === undefined && parent?.priority !== undefined && parent.priority <= 2 ? parent.priority : undefined;
      return {
        event: { type: "ticket.add", id, title, estimateMin, under, status: status?.status, closeReason: closeReasonOption(values["close-reason"]) ?? status?.closeReason, priority: explicit ?? inherited, waitsFor, source, refs },
        message: `Added ${id}: ${title} (${estimateMin} min)${under ? `, under ${under}` : ""}${inherited !== undefined ? `, at P${inherited} (from ${under})` : ""}${waitsFor ? `, waits for ${waitsFor}` : ""}${source ? `, source ${source.path ?? source.url}` : ""}${refs ? `, ref ${refs.join(", ")}` : ""}`,
      };
    },
  },
  "ticket update": {
    usage: `ticket update <id> [--status <status>] [--priority <0-4>] [--close-reason <done|skipped>] [--stage <name>] [--title <text>] [--estimate <minutes>] [--note <text>] [--waits-for <id>] [--under <id>] [--source <path or http(s) URL>[=<label>]] [--ref <ref> ...]`,
    summary: `Change a ticket. Statuses: open, in_progress, blocked, closed; a close carries --close-reason done|skipped (default done). --priority is how urgent it is, 0-4. --stage names the step in progress, like Build or Fixes ("" clears it). --waits-for names a ticket it can't start before ("" clears it); waiting is not stuck, so don't mark it blocked for that. --under moves the ticket, with its children, under another ticket ("" lifts it back to the top level); its id stays the same, and a move under its own child is refused. --source is where the ticket is written up ("" clears it). --ref is where the work came from; repeat it to replace all links at once.`,
    options: { status: { type: "string" }, priority: { type: "string" }, "close-reason": { type: "string" }, stage: { type: "string" }, title: { type: "string" }, estimate: { type: "string" }, note: { type: "string" }, "waits-for": { type: "string" }, under: { type: "string" }, source: { type: "string" }, ref: { type: "string", multiple: true } },
    run({ positionals, values, state, cwd, root }) {
      const ticket = existingTicket(state, positionals[0]);
      const rawWaitsFor = values["waits-for"] === undefined ? undefined : String(values["waits-for"]).trim();
      const waitsFor = rawWaitsFor === undefined || rawWaitsFor === "" ? rawWaitsFor : existingTicket(state, rawWaitsFor).id;
      if (waitsFor && waitsFor === ticket.id) throw new UsageError(`${ticket.id} can't wait for itself.`);
      // Refuse a loop (T01 waits for T02 waits for T01): neither could ever start.
      for (let next = waitsFor ? state.dashboard.tickets.find((entry) => entry.id === waitsFor) : undefined, seen = 0; next?.waitsFor && seen < 1000; seen++) {
        if (next.waitsFor === ticket.id) throw new UsageError(`${ticket.id} can't wait for ${waitsFor}: ${next.id} already waits for ${ticket.id}, so neither could start.`);
        next = state.dashboard.tickets.find((entry) => entry.id === next!.waitsFor);
      }
      // --under moves the ticket (its children follow); "" lifts it to the top
      // level. The id stays: the tree is the `under` field, not the id.
      const rawUnder = values.under === undefined ? undefined : String(values.under).trim();
      const under = rawUnder === undefined || rawUnder === "" ? rawUnder : existingTicket(state, rawUnder).id;
      if (under) {
        if (under === ticket.id) throw new UsageError(`${ticket.id} can't go under itself.`);
        // Refuse a move under its own child, grandchild or any descendant.
        const byId = new Map(state.dashboard.tickets.map((entry) => [entry.id, entry]));
        for (let up = byId.get(under), seen = 0; up && seen < 1000; seen++, up = up.under ? byId.get(up.under) : undefined) {
          if (up.id === ticket.id) throw new UsageError(`${ticket.id} can't go under ${under}: ${under} is inside ${ticket.id}.`);
        }
      }
      const status = statusOption(values.status);
      const event = {
        type: "ticket.update" as const,
        id: ticket.id,
        under,
        title: stringOption(values.title),
        estimateMin: minutesOption(values.estimate, "estimate"),
        status: status?.status,
        closeReason: closeReasonOption(values["close-reason"]) ?? status?.closeReason,
        priority: priorityOption(values.priority),
        stage: stringOption(values.stage),
        note: stringOption(values.note),
        waitsFor,
        source: values.source === undefined ? undefined : String(values.source).trim() === "" ? "" as const : parseFile(String(values.source), cwd, root),
        refs: refsOption(values),
      };
      const changes = Object.entries(event).filter(([key, value]) => key !== "type" && key !== "id" && value !== undefined);
      if (!changes.length) throw new UsageError("Nothing to change. Pass --status, --priority, --stage, --title, --estimate, --note, --waits-for, --under, --source, or --ref.");
      const shown = (value: unknown) => (typeof value === "object" && !Array.isArray(value) ? (value as FileLink).path ?? (value as FileLink).url : Array.isArray(value) ? value.join(", ") : value);
      const others = changes.filter(([key]) => key !== "under");
      const moved = under === undefined ? "" : under ? `Moved ${ticket.id} under ${under}` : `Lifted ${ticket.id} to the top level`;
      const updated = others.length ? `Updated ${ticket.id}: ${others.map(([key, value]) => `${key} ${shown(value)}`).join(", ")}` : "";
      return { event, message: [moved && `${moved} (the id stays ${ticket.id}; its children go with it)`, updated].filter(Boolean).join(". ") };
    },
  },
  "ticket claim": {
    usage: `ticket claim <id> [--stage <name>] [--note <text>]`,
    summary: "Take a ticket: set it in_progress and stamp you as the one on it.",
    options: { stage: { type: "string" }, note: { type: "string" } },
    run({ positionals, values, state }) {
      const ticket = existingTicket(state, positionals[0]);
      const stage = stringOption(values.stage);
      const note = stringOption(values.note);
      return {
        event: { type: "ticket.update", id: ticket.id, status: "in_progress" as const, stage, note },
        message: `Claimed ${ticket.id}: ${ticket.title}${stage ? `, stage ${stage}` : ""}${note ? `, note ${note}` : ""}`,
      };
    },
  },
  "ticket done": {
    usage: `ticket done <id> [--note <text>]`,
    summary: "Close a ticket as done.",
    options: { note: { type: "string" } },
    run({ positionals, values, state }) {
      const ticket = existingTicket(state, positionals[0]);
      const note = stringOption(values.note);
      // A parent never closes over an open child (Des, 21 Oct): settle the
      // subtree first, or the children are orphaned with no one to pick them up.
      const open = openChildren(state.dashboard, ticket.id);
      if (open.length) {
        const ids = open.map((child) => child.id).join(", ");
        throw new UsageError(`Refusing to close ${ticket.id}: ${open.length === 1 ? "one open child is" : `${open.length} open children are`} still under it (${ids}). Settle the subtree first — ${USAGE_NAME} ticket done ${open[0].id} --note "<the proof>" — then close ${ticket.id}. Nothing was written.`);
      }
      return {
        event: { type: "ticket.update", id: ticket.id, status: "closed" as const, closeReason: "done" as const, note },
        message: `Done ${ticket.id}: ${ticket.title}${note ? `, note ${note}` : ""}`,
      };
    },
  },
  "ticket remove": {
    usage: `ticket remove <id>`,
    summary: "Remove a ticket from the dashboard.",
    run({ positionals, state }) {
      const ticket = existingTicket(state, positionals[0]);
      return { event: { type: "ticket.remove", id: ticket.id }, message: `Removed ${ticket.id}: ${ticket.title}` };
    },
  },
  "ticket move": {
    usage: `ticket move <id> --to <workspace-id>`,
    summary: "Reallocate a ticket to another workspace: it leaves this workspace's board and renders only on the target's (and --all). Children follow the parent. Event-sourced: a correction is appended, nothing is rewritten.",
    options: { to: { type: "string" } },
    run({ positionals, values, state }) {
      const ticket = existingTicket(state, positionals[0]);
      const to = required(stringOption(values.to), "--to <workspace-id>");
      if (to === UNION_SCOPE) throw new UsageError("--to names a workspace, not the All view.");
      if (ticket.ws === to) throw new UsageError(`${ticket.id} is already on workspace ${to}.`);
      return { event: { type: "ticket.move" as const, id: ticket.id, to }, message: `Moved ${ticket.id}: ${ticket.title} to ${to}` };
    },
  },
  "ticket claim-from-all": {
    usage: `ticket claim-from-all <id>`,
    summary: "Claim a ticket visible in --all into your workspace: the same reallocation as ticket move with --to your workspace. Children follow the parent.",
    run({ positionals, state, scope }) {
      const ticket = existingTicket(state, positionals[0]);
      if (!scope) throw new UsageError("claim-from-all needs a Paseo agent id that resolves to a workspace (run it from a Paseo seat).");
      if (ticket.ws === scope) throw new UsageError(`${ticket.id} is already on workspace ${scope}.`);
      return { event: { type: "ticket.move" as const, id: ticket.id, to: scope }, message: `Claimed ${ticket.id}: ${ticket.title} into ${scope}` };
    },
  },
  "question ask": {
    usage: `question ask "<short title>" "<question>" [--option "A=<label> | <consequence>" ...] --recommend <letter or word> [--background <text>] [--file <path or http(s) URL>[=<label>] ...] [--raised-by <text>] [--ticket <id>]`,
    summary: "Ask the user a question. Prints its reference (Q1, Q2, ...). --recommend is the option you would pick. Build no option before the answer: work only on what the question doesn't affect, and if nothing else is left, stop and wait.",
    options: {
      option: { type: "string", multiple: true },
      recommend: { type: "string" },
      background: { type: "string" },
      file: { type: "string", multiple: true },
      "raised-by": { type: "string" },
      ticket: { type: "string" },
    },
    run({ positionals, values, state, cwd, root }) {
      const title = required(positionals[0], "short title");
      const ticket = values.ticket === undefined ? undefined : existingTicket(state, stringOption(values.ticket));
      const question = required(positionals[1], "question");
      const options = listOption(values.option).map(parseOption);
      const letters = options.map((option) => option.letter);
      const duplicate = letters.find((letter, index) => letters.indexOf(letter) !== index);
      if (duplicate) throw new UsageError(`Option ${duplicate} is given twice.`);
      let recommend = required(stringOption(values.recommend), "--recommend (the option you would pick)");
      if (options.length) {
        if (!/^[A-Za-z]$/.test(recommend) || !letters.includes(recommend.toUpperCase())) {
          throw new UsageError(`--recommend must be one of the option letters: ${letters.join(", ")}.`);
        }
        recommend = recommend.toUpperCase();
      }
      const id = state.nextIds.question;
      return {
        event: {
          type: "question.ask",
          id,
          title,
          question,
          options: options.length ? options : undefined,
          recommend,
          background: stringOption(values.background),
          files: listOption(values.file).length ? listOption(values.file).map((raw) => parseFile(raw, cwd, root)) : undefined,
          raisedBy: stringOption(values["raised-by"]),
          ticket: ticket?.id,
        },
        message: `Asked ${id} (${title}). You recommend ${recommend}. Build no option before the answer: work only on what it doesn't affect, and if nothing else is left, stop and wait.`,
      };
    },
  },
  "question answer": {
    usage: `question answer <id> <choice> [--words "<what the user said>"]`,
    summary: "Record the user's answer. Choice is an option letter or the user's own short answer.",
    options: { words: { type: "string" } },
    run({ positionals, values, state }) {
      const question = existingQuestion(state, positionals[0]);
      let choice = required(positionals[1], "choice");
      const letters = question.options.map((option) => option.letter);
      if (/^[A-Za-z]$/.test(choice)) {
        choice = choice.toUpperCase();
        if (letters.length && !letters.includes(choice)) throw new UsageError(`${question.id} has options ${letters.join(", ")}, not ${choice}.`);
      }
      const asRecommended = choice.toLowerCase() === question.recommended.toLowerCase();
      return {
        event: { type: "question.answer", id: question.id, choice, words: stringOption(values.words) },
        message: `Answered ${question.id}: ${choice}${asRecommended ? " (as you recommended)" : ` (not your recommendation, ${question.recommended})`}. Build it now.`,
      };
    },
  },
  "question update": {
    usage: `question update <id> [--background <text>] [--question <text>] [--file <path or http(s) URL>[=<label>] ...]`,
    summary: "Add detail to a question: replace its background or wording, or add files. Its reference and default stay.",
    options: { background: { type: "string" }, question: { type: "string" }, file: { type: "string", multiple: true } },
    run({ positionals, values, state, cwd, root }) {
      const question = existingQuestion(state, positionals[0]);
      const files = listOption(values.file).map((raw) => parseFile(raw, cwd, root));
      const event = {
        type: "question.update" as const,
        id: question.id,
        question: stringOption(values.question),
        background: stringOption(values.background),
        files: files.length ? files : undefined,
      };
      if (!event.question && !event.background && !event.files) throw new UsageError("Nothing to change. Pass --background, --question, or --file.");
      return { event, message: `Updated ${question.id} (${question.title})` };
    },
  },
  "question remove": {
    usage: `question remove <id>`,
    summary: "Withdraw a question. Its reference is not reused.",
    run({ positionals, state }) {
      const question = existingQuestion(state, positionals[0]);
      return { event: { type: "question.remove", id: question.id }, message: `Removed ${question.id} (${question.title})` };
    },
  },
  "deliverable add": {
    usage: `deliverable add "<title>" <path or http(s) URL> [--ticket <id>] [--kind ${DELIVERABLE_KINDS.join("|")}]`,
    summary: "Add something the user can review. Paths are relative to where you run the command. Prints its id (D1, D2, ...).",
    options: { ticket: { type: "string" }, kind: { type: "string" } },
    run({ positionals, values, state, cwd, root }) {
      const title = required(positionals[0], "deliverable title");
      const target = required(positionals[1], "path or URL");
      const ticket = values.ticket === undefined ? undefined : existingTicket(state, stringOption(values.ticket));
      const kind = stringOption(values.kind);
      if (kind !== undefined && !(DELIVERABLE_KINDS as readonly string[]).includes(kind)) {
        throw new UsageError(`--kind must be one of: ${DELIVERABLE_KINDS.join(", ")}.`);
      }
      const isUrl = URL_PATTERN.test(target);
      if (isUrl && !/^https?:\/\//i.test(target)) throw new UsageError("Only http(s) URLs are supported; give local files as a path.");
      const id = state.nextIds.deliverable;
      return {
        event: {
          type: "deliverable.add",
          id,
          title,
          ...(isUrl ? { url: target } : { path: rootRelative(target, cwd, root) }),
          ticket: ticket?.id,
          kind: (kind as (typeof DELIVERABLE_KINDS)[number] | undefined) ?? guessKind(target, isUrl, cwd),
        },
        message: `Added ${id}: ${title}`,
      };
    },
  },
  "deliverable remove": {
    usage: `deliverable remove <id>`,
    summary: "Remove a deliverable from the dashboard.",
    run({ positionals, state }) {
      const wanted = required(positionals[0], "deliverable id").toUpperCase();
      const deliverable = state.dashboard.deliverables.find((candidate) => candidate.id === wanted);
      if (!deliverable) {
        const known = state.dashboard.deliverables.map((candidate) => candidate.id).join(", ") || "none";
        throw new UsageError(`No deliverable ${wanted} in this run. Deliverables: ${known}.`);
      }
      return { event: { type: "deliverable.remove", id: deliverable.id }, message: `Removed ${deliverable.id}: ${deliverable.title}` };
    },
  },
  "activity add": {
    usage: `activity add "<text>" [--ticket <id>]`,
    summary: "Log a short note in the Activity feed, on the ticket it is about. Prints its id (A1, A2, ...).",
    options: { ticket: { type: "string" } },
    run({ positionals, values, state }) {
      const text = required(positionals[0], "activity text");
      const ticket = values.ticket === undefined ? undefined : existingTicket(state, stringOption(values.ticket));
      const id = state.nextIds.activity;
      return { event: { type: "activity.add", id, text, ticket: ticket?.id }, message: `Logged ${id}${ticket ? ` on ${ticket.id}` : ""}: ${text}` };
    },
  },
  "activity update": {
    usage: `activity update <id> "<text>"`,
    summary: "Reword an activity note.",
    run({ positionals, state }) {
      const entry = existingActivity(state, positionals[0]);
      const text = required(positionals[1], "activity text");
      return { event: { type: "activity.update", id: entry.id, text }, message: `Updated ${entry.id}: ${text}` };
    },
  },
  "activity remove": {
    usage: `activity remove <id>`,
    summary: "Remove an activity note.",
    run({ positionals, state }) {
      const entry = existingActivity(state, positionals[0]);
      return { event: { type: "activity.remove", id: entry.id }, message: `Removed ${entry.id}: ${entry.text}` };
    },
  },
  "ticker set": {
    usage: `ticker set "<text>"`,
    summary: "Show one line at the top saying what you are doing right now.",
    run({ positionals }) {
      const text = required(positionals[0], "ticker text");
      return { event: { type: "ticker.set", text }, message: `Ticker: ${text}` };
    },
  },
  "ticker clear": {
    usage: `ticker clear`,
    summary: "Hide the ticker line.",
    run() {
      return { event: { type: "ticker.clear" }, message: "Ticker cleared" };
    },
  },
  "stuck set": {
    usage: `stuck set "<reason>" [--ticket <id>]`,
    summary: "Flag a blocker that is not a ticket status. Prints its id (S1, S2, ...).",
    options: { ticket: { type: "string" } },
    run({ positionals, values, state }) {
      const reason = required(positionals[0], "reason");
      const ticket = values.ticket === undefined ? undefined : existingTicket(state, stringOption(values.ticket));
      const id = state.nextIds.stuck;
      return { event: { type: "stuck.set", id, reason, ticket: ticket?.id }, message: `Flagged ${id}: ${reason}` };
    },
  },
  "conn set": {
    usage: `conn set --budget <n> --mode <live|keepalive> --next-nudge-at <iso> [--clear]`,
    summary: "Store the conn (full auto) state the DCI engine owns; the panel and show display it. Rewrite it on every nudge: it keeps its since until conn clear. --clear marks full auto clear (work the board down, then turn off at idle); a rewrite without it drops the mark. --workspace <id> targets a seat's board from outside it. Live means work is outstanding; keepalive means only the cache keep-alive is pending.",
    options: { budget: { type: "string" }, mode: { type: "string" }, "next-nudge-at": { type: "string" }, clear: { type: "boolean" } },
    run({ values }) {
      const budget = Number(required(stringOption(values.budget), "--budget <n>"));
      if (!Number.isInteger(budget) || budget < 1) throw new UsageError("--budget is a whole number of 1 or more.");
      const mode = required(stringOption(values.mode), `--mode <${CONN_MODES.join("|")}>`);
      if (!(CONN_MODES as readonly string[]).includes(mode)) throw new UsageError(`--mode is one of ${CONN_MODES.join(", ")}.`);
      const next = new Date(required(stringOption(values["next-nudge-at"]), "--next-nudge-at <iso>"));
      if (Number.isNaN(next.getTime())) throw new UsageError("--next-nudge-at is an ISO date and time, like 2026-10-15T09:30:00Z.");
      const nextNudgeAt = next.toISOString();
      const clear = values.clear === true;
      return { event: { type: "conn.set", budget, mode: mode as ConnMode, nextNudgeAt, ...(clear ? { clear: true as const } : {}) }, message: `Conn on: budget ${budget}${clear ? ", clear" : ""}, ${mode}, next nudge ${nextNudgeAt}` };
    },
  },
  "conn clear": {
    usage: `conn clear`,
    summary: "Turn the stored conn state off; show leaves its conn fields out. --workspace <id> targets a seat's board from outside it.",
    run() {
      return { event: { type: "conn.clear" }, message: "Conn off" };
    },
  },
  "hold set": {
    usage: `hold set --kind <closed|speccing> [--note <text>]`,
    summary: "Put the board on hold: items can still be added, but no work starts (claim and moving an objective into progress are refused until hold clear). closed means closed to work; speccing means the owner is here speccing. Rewrite it to change the kind or note: it keeps its since until hold clear. --workspace <id> targets a seat's board from outside it.",
    options: { kind: { type: "string" }, note: { type: "string" } },
    run({ values }) {
      const kind = required(stringOption(values.kind), `--kind <${HOLD_KINDS.join("|")}>`);
      if (!(HOLD_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind is one of ${HOLD_KINDS.join(", ")}.`);
      const note = stringOption(values.note);
      return { event: { type: "hold.set", kind: kind as HoldKind, ...(note ? { note } : {}) }, message: `Board on hold: ${kind}${note ? `, ${note}` : ""}` };
    },
  },
  "hold clear": {
    usage: `hold clear`,
    summary: "Lift the hold: work may start again. --workspace <id> targets a seat's board from outside it.",
    run() {
      return { event: { type: "hold.clear" }, message: "Hold lifted" };
    },
  },
  "stuck clear": {
    usage: `stuck clear <id>`,
    summary: "Clear a flagged blocker.",
    run({ positionals, state }) {
      const wanted = required(positionals[0], "stuck id").toUpperCase();
      const item = state.dashboard.stuck.find((candidate) => candidate.kind === "manual" && candidate.id === wanted);
      if (!item || item.kind !== "manual") {
        const known = state.dashboard.stuck.flatMap((candidate) => (candidate.kind === "manual" ? [candidate.id] : [])).join(", ") || "none";
        throw new UsageError(`No flagged blocker ${wanted}. Flagged: ${known}.`);
      }
      return { event: { type: "stuck.clear", id: item.id }, message: `Cleared ${item.id}: ${item.reason}` };
    },
  },
};

// Stored relative to the worktree root so the panel can resolve it against
// the workspace directory; paths outside the worktree stay absolute.
function rootRelative(target: string, cwd: string, root: string): string {
  const absolute = resolve(cwd, target);
  const inside = relative(root, absolute);
  const suffix = /[\/]$/.test(target) ? "/" : "";
  if (!inside) return "./";
  return outside(inside) ? absolute + suffix : inside + suffix;
}

function guessKind(target: string, isUrl: boolean, cwd: string): (typeof DELIVERABLE_KINDS)[number] {
  if (isUrl) return "link";
  if (/[\/]$/.test(target) || statSync(resolve(cwd, target), { throwIfNoEntry: false })?.isDirectory()) return "folder";
  if (imageMimeType(target)) return "screenshot";
  return "file";
}

const SHOW_SUMMARY = "Print the dashboard as text: what the user sees in the Progress panel. Flags: --mine (only your work), --all (every workspace), --json (machine-readable, with the board indicator), --status <open,in_progress,blocked,closed> and --priority <0-4, none, a list or a range like 0-2> to cut the objectives, --ready (open or in progress, P0 to P2: what a seat may pull; P3, P4 and none are owner-held). While conn is on, the conn state and indicator print too. --workspace <id> reads another workspace's board.";
const TICKET_SHOW_USAGE = "ticket show <id> [--json]";
const TICKET_SHOW_SUMMARY = "Print one objective: its status, priority (when set), estimate and name. --json gives the whole objective for a machine.";
const INSTALL_SUMMARY = "Write the paseo-progress launcher (default ~/.local/bin/paseo-progress). It runs this command from whichever copy of the plugin Paseo is running.";
const STATE_SUMMARY = "Print the folder where this worktree's board lives, or rebuild that folder from the repo. The folder is a cache: its key is the resolved worktree root (realpath, nearest .git) plus the machine plus its first eight hex, and its contents can always be replayed from the run files the repo saves. `state path` prints the folder, so a script that moves a repo prints it before the move and after. `state restore` replays this machine's saved runs in filename order, keeps a dated copy of the file it replaces, and writes the rebuilt board; it needs a git worktree and never reads another machine's folder.";
const DEFAULT_LAUNCHER = "~/.local/bin/paseo-progress";

function help(): string {
  return [
    `Usage: ${USAGE_NAME} <command>`,
    "",
    `Records progress for this worktree, shown by the Progress panel in Paseo. The file lives outside the repo, so git never sees it.`,
    `Add --help after any command for its options.`,
    "",
    ...Object.values(commands).flatMap((command) => [`  ${command.usage}`, `      ${command.summary}`]),
    `  show`,
    `      ${SHOW_SUMMARY}`,
    `  ${TICKET_SHOW_USAGE}`,
    `      ${TICKET_SHOW_SUMMARY}`,
    `  install-launcher [path]`,
    `      ${INSTALL_SUMMARY}`,
    `  state path [dir]`,
    `      ${STATE_SUMMARY}`,
  ].join("\n");
}

const BOARD_CLEAR_LINE = "Board is clear: full auto clear is off. Remove the ♾️ from your agent name and workspace name.";

const BOARD_STATUS_WORDS: readonly BoardStatus[] = ["open", "in_progress", "blocked", "closed"];

// One --priority token: a priority 0-4, "none", or a range like 0-2.
function priorityTokens(token: string): Array<number | "none"> {
  const word = token.trim();
  if (word === "none") return ["none"];
  const range = /^([0-4])(?:-([0-4]))?$/.exec(word);
  if (!range || (range[2] !== undefined && Number(range[2]) < Number(range[1]))) throw new UsageError("--priority is 0 to 4, none, a list like 0,2, or a range like 0-2.");
  const from = Number(range[1]);
  const to = range[2] === undefined ? from : Number(range[2]);
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

// show's cut of the objectives: --status, --priority, and --ready (open or in
// progress, P0 to P2). An explicit flag narrows what --ready names.
function showFilter(values: { status?: unknown; priority?: unknown; ready?: unknown }): TicketFilter | undefined {
  const status = stringOption(values.status);
  const priority = stringOption(values.priority);
  if (status === undefined && priority === undefined && values.ready !== true) return undefined;
  const base = values.ready === true ? READY_TO_PULL : {};
  const statuses = status === undefined ? base.statuses : status.split(",").map((word) => {
    const name = word.trim() as BoardStatus;
    if (!BOARD_STATUS_WORDS.includes(name)) throw new UsageError(`--status is a list of: ${BOARD_STATUS_WORDS.join(", ")}.`);
    return name;
  });
  return { statuses, priorities: priority === undefined ? base.priorities : priority.split(",").flatMap(priorityTokens) };
}

// While conn is on: its state and the indicator the panel shows (a running
// agent is not known here, so Stale can read stricter than the panel). With
// conn off nothing is added, so plain show stays byte-identical to 0.4.0;
// show --json always carries the indicator.
function statusText(dashboard: Dashboard): string {
  const { conn, hold } = dashboard;
  const connLines = conn ? `\n\nConn: on, budget ${conn.budget}${conn.clear ? ", clear" : ""}, ${conn.mode}, since ${conn.since}, next nudge ${conn.nextNudgeAt}\nStatus: ${boardStatuses(dashboard, false).map(indicatorLabel).join(", ")}` : "";
  // A held board says so last, so a reader stops there: items only, no work.
  const holdLine = hold ? `${conn ? "\n" : "\n\n"}Hold: ${hold.kind}, since ${hold.since}${hold.note ? `, ${hold.note}` : ""}` : "";
  return `${connLines}${holdLine}`;
}

// Whether an event is board content: it folds only from the last `run.start`
// on, so writing one with no run makes it invisible while the command reports
// success (Des saw this live, 2026-10-19: an add that `show` never showed).
// Conn and hold are board state, not content, and still land with no run.
const BOARD_CONTENT_EVENTS: ReadonlySet<ProgressEvent["type"]> = new Set([
  "ticket.add",
  "ticket.update",
  "ticket.remove",
  "ticket.move",
  "stuck.set",
  "stuck.clear",
  "question.ask",
  "question.answer",
  "question.update",
  "question.remove",
  "deliverable.add",
  "deliverable.remove",
  "activity.add",
  "activity.update",
  "activity.remove",
  "ticker.set",
  "ticker.clear",
]);

// Whether an event starts work: a new objective already in progress, or an
// existing one moving into progress. A hold refuses exactly these.
function startsWork(event: EventDraft, dashboard: Dashboard): boolean {
  if (event.type === "ticket.add") return event.status === "in_progress";
  if (event.type === "ticket.update" && event.status === "in_progress") {
    return dashboard.tickets.find((ticket) => ticket.id === displayId(event.id))?.status !== "in_progress";
  }
  return false;
}

// The ancestors of a ticket (or of a ticket about to be added under `parent`)
// that are not in progress, topmost first. A child cannot be in progress under
// a parent nobody has claimed: the dashboard would show work with no owner on
// the objective above it.
function idleAncestors(dashboard: Dashboard, parent: string | undefined): Ticket[] {
  const idle: Ticket[] = [];
  const seen = new Set<string>();
  let id = parent === undefined || parent === "" ? undefined : displayId(parent);
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const ticket = dashboard.tickets.find((candidate) => candidate.id === id);
    if (!ticket) break;
    if (ticket.status !== "in_progress") idle.unshift(ticket);
    id = ticket.under === undefined || ticket.under === "" ? undefined : displayId(ticket.under);
  }
  return idle;
}

function parentOf(event: EventDraft, dashboard: Dashboard): string | undefined {
  if (event.type === "ticket.add") return event.under;
  if (event.type === "ticket.update") return dashboard.tickets.find((ticket) => ticket.id === displayId(event.id))?.under;
  return undefined;
}

// --workspace <id>, anywhere in the arguments: act on that workspace's board
// instead of the caller's, so a process outside the seat (the DCI engine) can
// write the seat's conn state.
function takeWorkspaceFlag(argv: string[]): { rest: string[]; workspace?: string; missing: boolean } {
  const rest: string[] = [];
  let workspace: string | undefined;
  let missing = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--workspace=")) workspace = arg.slice("--workspace=".length);
    else if (arg === "--workspace") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) missing = true;
      else { workspace = value; index += 1; }
    } else rest.push(arg);
  }
  return { rest, workspace: workspace || undefined, missing: missing || workspace === "" };
}

// --quiet / -q, anywhere in the arguments: Paseo's own CLI advertises it as a
// global flag, so a caller that passes it here must not be refused as an
// unknown option (Des, 2026-10-19). It silences a successful command's result
// line; errors and `show` output still print.
function takeQuietFlag(argv: string[]): { rest: string[]; quiet: boolean } {
  const rest = argv.filter((arg) => arg !== "--quiet" && arg !== "-q");
  return { rest, quiet: rest.length !== argv.length };
}

export async function runCli(rawArgv: string[], options: CliOptions): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const quietFlag = takeQuietFlag(rawArgv);
  const { rest: argv, workspace, missing } = takeWorkspaceFlag(quietFlag.rest);
  const quiet = quietFlag.quiet;
  if (missing) {
    out("--workspace needs a workspace id.");
    return 1;
  }
  // The workspace id resolves once per call: every read and write in this
  // call scopes to it. No agent, or no record, is unscoped (All, as 0.4.0).
  const scope = workspace ?? options.workspaceId ?? (options.agentId ? resolveWorkspaceId(options.agentId) : undefined);
  const [first, second] = argv;
  if (!first || first === "--help" || first === "-h" || first === "help") {
    out(help());
    return first ? 0 : 1;
  }
  if (first === "state") {
    const [, sub, target] = argv;
    if (!sub || sub === "--help" || sub === "-h") {
      out(`Usage: ${USAGE_NAME} state path [dir]\n       ${USAGE_NAME} state restore [--dry-run]\n\n${STATE_SUMMARY}`);
      return sub ? 0 : 1;
    }
    if (sub === "restore") {
      const dryRun = argv.includes("--dry-run");
      const result = await restoreState(findRoot(options.cwd), { dryRun });
      out(`${dryRun ? "Would restore" : "Restored"} ${result.events} events from ${result.files} saved runs for ${result.machine} into ${result.directory}${result.backup ? `; the file it replaced is kept at ${result.backup}` : ""}`);
      return 0;
    }
    if (sub !== "path") {
      out(`Unknown state command: ${sub}\nUsage: ${USAGE_NAME} state path [dir] | state restore [--dry-run]`);
      return 1;
    }
    out(outsideDirectory(findRoot(target ?? options.cwd)));
    return 0;
  }

  if (first === "show" || first === "install-launcher") {
    if (argv.slice(1).includes("--help") || argv.slice(1).includes("-h")) {
      out(first === "show" ? `Usage: ${USAGE_NAME} show\n\n${SHOW_SUMMARY}` : `Usage: ${USAGE_NAME} install-launcher [path]\n\n${INSTALL_SUMMARY}`);
      return 0;
    }
    if (first === "show") {
      const root = findRoot(options.cwd);
      const store = await findStore(root);
      let parsed;
      try {
        parsed = parseArgs({ args: argv.slice(1), options: { mine: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" }, status: { type: "string" }, priority: { type: "string" }, ready: { type: "boolean" } }, allowPositionals: true, strict: true });
      } catch (error) {
        out(`${(error as Error).message}\nUsage: ${USAGE_NAME} show [--mine] [--all] [--json] [--status <list>] [--priority <list|range|none>] [--ready]`);
        return 1;
      }
      let filter: TicketFilter | undefined;
      try {
        filter = showFilter(parsed.values);
      } catch (error) {
        if (!(error instanceof UsageError)) throw error;
        out(`${error.message}\nUsage: ${USAGE_NAME} show [--mine] [--all] [--json] [--status <list>] [--priority <list|range|none>] [--ready]`);
        return 1;
      }
      const flags = { mine: parsed.values.mine === true, all: parsed.values.all === true, json: parsed.values.json === true };
      if (!flags.mine && !flags.all && !flags.json && !filter) {
        // Plain show: byte-identical to 0.4.0 for an unscoped call, and this
        // workspace's own board for a scoped one.
        const { dashboard } = await readProgress(store.directory, now(), scope);
        const added = addedByOthersText(addedByOthers(await readLatestRun(store.directory), dashboard, options.agentId), dashboard);
        out(`Worktree: ${root}\n\n${dashboardText(dashboard, now().getTime())}${added}${statusText(dashboard)}`);
        return 0;
      }
      if (flags.mine && options.agentId === undefined) {
        out("show --mine needs a Paseo agent id (run it from a Paseo seat).");
        return 1;
      }
      // --all folds every workspace's current run together (owner union);
      // the other views stay in this workspace.
      const { dashboard } = await readProgress(store.directory, now(), flags.all ? UNION_SCOPE : scope);
      let view = dashboard;
      if (flags.mine) {
        // Question ids never restart, so matching asked-by on the unscoped run
        // is safe; tickets match on the ticket's own `by` (its last agent).
        const askedByMe = new Set((await readLatestRun(store.directory)).flatMap((event) => (event.type === "question.ask" && event.by === options.agentId ? [event.id] : [])));
        view = {
          ...dashboard,
          tickets: dashboard.tickets.filter((ticket) => ticket.agentId === options.agentId),
          questions: { ...dashboard.questions, open: dashboard.questions.open.filter((question) => askedByMe.has(question.id)) },
        };
      }
      // A held board has nothing ready to pull.
      if (filter) view = { ...view, tickets: parsed.values.ready === true && dashboard.hold ? [] : filterTickets(view.tickets, filter) };
      if (flags.json) {
        out(JSON.stringify({ worktree: root, dashboard: view, indicator: boardStatuses(view, false) }, null, 2));
        return 0;
      }
      const added = flags.mine ? "" : addedByOthersText(addedByOthers(await readLatestRun(store.directory), view, options.agentId), view);
      out(`Worktree: ${root}\n\n${dashboardText(view, now().getTime())}${added}${statusText(view)}`);
      return 0;
    }
    const target = resolve(options.cwd, (argv[1] ?? DEFAULT_LAUNCHER).replace(/^~(?=$|\/)/, homedir()));
    const boards = join(dirname(target), "paseo-boards");
    out(await installLaunchers(target) ? `Installed the launchers at ${target} and ${boards}` : `The launchers at ${target} and ${boards} are already current`);
    return 0;
  }
  if (first === "ticket" && second === "show") {
    if (argv.slice(2).includes("--help") || argv.slice(2).includes("-h")) {
      out(`Usage: ${USAGE_NAME} ${TICKET_SHOW_USAGE}\n\n${TICKET_SHOW_SUMMARY}`);
      return 0;
    }
    let parsed;
    try {
      parsed = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } }, allowPositionals: true, strict: true });
    } catch (error) {
      out(`${(error as Error).message}\nUsage: ${USAGE_NAME} ${TICKET_SHOW_USAGE}`);
      return 1;
    }
    const wanted = parsed.positionals[0];
    if (!wanted) {
      out(`Missing ticket id.\nUsage: ${USAGE_NAME} ${TICKET_SHOW_USAGE}`);
      return 1;
    }
    const store = await findStore(findRoot(options.cwd));
    const { dashboard } = await readProgress(store.directory, now(), scope);
    const ticket = dashboard.tickets.find((candidate) => candidate.id === displayId(wanted));
    if (!ticket) {
      out(`No ticket ${wanted} in this run. Tickets: ${dashboard.tickets.map((candidate) => candidate.id).join(", ") || "none"}.`);
      return 1;
    }
    out(parsed.values.json ? JSON.stringify({ worktree: findRoot(options.cwd), ticket }, null, 2) : ticketLines(ticket).join("\n"));
    return 0;
  }
  const twoWord = commands[`${first} ${second}`];
  const command = twoWord ?? commands[first];
  if (!command) {
    out(`Unknown command: ${[first, second].filter(Boolean).join(" ")}\n\n${help()}`);
    return 1;
  }
  const rest = argv.slice(twoWord ? 2 : 1);
  if (rest.includes("--help") || rest.includes("-h")) {
    out(`Usage: ${USAGE_NAME} ${command.usage}\n\n${command.summary}`);
    return 0;
  }
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: command.options ?? {}, allowPositionals: true, strict: true });
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    const root = findRoot(options.cwd);
    const store = await findStore(root);
    // Set when the command closes an objective: its bead refs cascade (O2100).
    let cascade: { refs: string[]; reason: string } | undefined;
    // Move verbs resolve the ticket across every workspace (claim-from-all
    // works from the All view), but the written event stamps this workspace.
    const moveVerb = command === commands["ticket move"] || command === commands["ticket claim-from-all"];
    const message = await appendProgress(store.directory, now, (state) => {
      const finished = state.dashboard.run?.finished;
      // Conn and hold are board state, not objectives: they still land on a finished board.
      const boardState = command === commands["conn set"] || command === commands["conn clear"] || command === commands["hold set"] || command === commands["hold clear"];
      if (finished && command !== commands.start && command !== commands.rename && !boardState) {
        // No agent id means the unscoped board, whose latest run may be one
        // another workspace finished. A sandbox that strips PASEO_* variables
        // (context-mode's ctx_execute) lands an agent here; say so.
        const noId = options.agentId ? "" : " No PASEO_AGENT_ID reached this command, so it read the unscoped board. A Paseo agent runs it from its own shell, not a sandbox that strips PASEO_* variables.";
        throw new UsageError(`The run "${state.dashboard.run!.title}" is finished. Start new work with: ${USAGE_NAME} start "<title>" --replace (nothing open is lost: a finished board has no open objectives).${noId}`);
      }
      const { event, message } = command.run({ positionals: parsed.positionals, values: parsed.values, state, cwd: options.cwd, root, scope });
      // Refuse board content with no run rather than writing an event the fold
      // will never show: persist-or-refuse (Des, 2026-10-19). The caller reads
      // one line telling it to start the run, and nothing reaches the file.
      if (!state.dashboard.run && BOARD_CONTENT_EVENTS.has(event.type)) {
        throw new UsageError(`No run yet. Start one with: ${USAGE_NAME} start "<title>". Nothing was written.`);
      }
      const { hold } = state.dashboard;
      if (hold && startsWork(event, state.dashboard)) {
        throw new UsageError(`The board is on hold (${hold.kind}${hold.note ? `: ${hold.note}` : ""}). Items can be added, but no work starts. The owner lifts it with: ${USAGE_NAME} hold clear`);
      }
      if (startsWork(event, state.dashboard)) {
        const idle = idleAncestors(state.dashboard, parentOf(event, state.dashboard));
        if (idle.length) {
          const names = idle.map((ticket) => `${ticket.id} (${ticket.status})`).join(", ");
          throw new UsageError(`A child cannot be in progress while its parent is not: ${names} ${idle.length === 1 ? "is" : "are"} not in progress. The agent that owns the objective claims the parent first: ${USAGE_NAME} ticket claim ${idle[0].id}${idle.length > 1 ? ", then each below it" : ""}. A helper does not own the parent it works under; ask your sponsor to claim it.`);
        }
      }
      if (event.type === "ticket.update" && event.status === "closed") {
        const ticket = state.dashboard.tickets.find((candidate) => candidate.id === event.id);
        cascade = { refs: event.refs ?? ticket?.refs ?? [], reason: event.closeReason ?? "done" };
      }
      const added = command === commands.start ? "" : addedByOthersText(addedByOthers(state.events, state.dashboard, options.agentId), state.dashboard);
      // Full auto clear: the close that leaves nothing to work turns the conn off, as conn clear does.
      const closedId = event.type === "ticket.update" && event.status === "closed" ? event.id : undefined;
      const boardCleared = closedId !== undefined && state.dashboard.conn?.clear === true
        && boardIsClear(state.dashboard.tickets.map((ticket) => (ticket.id === closedId ? { ...ticket, status: "closed" as const } : ticket)));
      return {
        event: { ...event, by: options.agentId, ws: scope },
        followUp: boardCleared ? { type: "conn.clear", by: options.agentId, ws: scope } : undefined,
        result: `${message}${added}${boardCleared ? `\n${BOARD_CLEAR_LINE}` : ""}`,
      };
    }, (text) => saveRunCopy(root, text, scope), moveVerb ? UNION_SCOPE : scope);
    if (cascade && cascade.refs.length) {
      // Fail soft: the close already landed; a bd fault is logged, never fatal.
      const failures = await closeBackingBeads(root, cascade.refs, cascade.reason);
      for (const failure of failures) console.error(`cascade: could not close bead ${failure.id}: ${failure.message}`);
    }
    if (!quiet) out(message);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof InvalidEvent) {
      out(`${error.message}\nUsage: ${USAGE_NAME} ${command.usage}`);
      return 1;
    }
    throw error;
  }
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
  runCli(process.argv.slice(2), { cwd: process.cwd(), agentId: process.env.PASEO_AGENT_ID || undefined }).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
