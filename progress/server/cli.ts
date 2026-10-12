// The command agents run to record progress. Each command appends one event
// to the worktree's progress file and prints what it recorded.
import { realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isSettled, displayId, ticketName, type Dashboard, type NextIds, type Ticket } from "../shared/dashboard.ts";
import { CLOSE_REASONS, DELIVERABLE_KINDS, type BoardStatus, type CloseReason, type FileLink, type ProgressEvent } from "../shared/events.ts";
import { appendProgress, InvalidEvent, readLatestRun, readProgress, type EventDraft } from "./progress-file.ts";
import { findRoot, outside } from "./paths.ts";
import { resolveWorkspaceId } from "./workspace.ts";
import { UNION_SCOPE } from "../shared/dashboard.ts";
import { installLauncher } from "./launcher.ts";
import { closeBackingBeads } from "./beads.ts";
import { findStore, saveRunCopy } from "./store.ts";
import { dashboardText } from "../shared/show.ts";
import { imageMimeType } from "../shared/attachments.ts";
import { homedir } from "node:os";

export interface CliOptions {
  cwd: string;
  now?: () => Date;
  out?: (line: string) => void;
  // The Paseo agent running the command, recorded on each event it writes.
  agentId?: string;
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
    `${one ? "It is" : "They are"} part of this run: work ${one ? "it" : "them"} in order after your current ${label}.`,
  ].join("\n");
}

const commands: Record<string, Command> = {
  start: {
    usage: `start "<title>" [--subtitle <text>] [--item-label <word>]`,
    summary: "Start a new run. Earlier runs stay in the file but leave the dashboard.",
    options: { subtitle: { type: "string" }, "item-label": { type: "string" } },
    run({ positionals, values }) {
      const title = required(positionals[0], "run title");
      return {
        event: { type: "run.start", title, subtitle: stringOption(values.subtitle), itemLabel: stringOption(values["item-label"]) },
        message: `Started run: ${title}`,
      };
    },
  },
  finish: {
    usage: `finish "<outcome>"`,
    summary: "Close the run with a one-line outcome. Every ticket must be done or skipped, no question open, nothing flagged stuck. New work after this needs start.",
    run({ positionals, state }) {
      const outcome = required(positionals[0], "outcome");
      if (!state.dashboard.run) throw new UsageError("No run to finish.");
      const left = unfinishedWork(state.dashboard);
      if (left.length) throw new UsageError(`Can't finish yet. Still open: ${left.join("; ")}.`);
      return { event: { type: "run.finish", outcome }, message: `Finished run: ${state.dashboard.run.title}` };
    },
  },
  "ticket add": {
    usage: `ticket add "<title>" --estimate <minutes> [--under <id>] [--status <status>] [--priority <0-4>] [--close-reason <done|skipped>] [--waits-for <id>] [--source <path or http(s) URL>[=<label>]] [--ref <ref> ...]`,
    summary: `Add a ticket. Prints its id (o1, o2, ...). --under nests it as the next child of another ticket, any depth (o1.1, o1.1.2). Statuses: open, in_progress, blocked, closed, with --close-reason done|skipped when closing. --priority is how urgent it is, 0-4. --waits-for names a ticket it can't start before; that is the order of work, not a blocker. --source is where the ticket is written up, like its spec file or issue link. --ref is where the work came from, like bead:<id>, gh:<owner>/<repo>#<n> or teams:<messageId>; repeat it to link more than one, and the name composes from the links.`,
    options: { estimate: { type: "string" }, under: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, "close-reason": { type: "string" }, "waits-for": { type: "string" }, source: { type: "string" }, ref: { type: "string", multiple: true } },
    run({ positionals, values, state, cwd, root }) {
      const waitsFor = values["waits-for"] === undefined ? undefined : existingTicket(state, stringOption(values["waits-for"])).id;
      const title = required(positionals[0], "ticket title");
      const estimateMin = minutesOption(values.estimate, "estimate");
      if (estimateMin === undefined) throw new UsageError("Missing --estimate <minutes>.");
      const source = values.source === undefined ? undefined : parseFile(String(values.source), cwd, root);
      const refs = refsOption(values);
      const under = values.under === undefined ? undefined : existingTicket(state, stringOption(values.under)).id;
      const id = under ? nextChildId(state.events, under) : state.nextIds.ticket;
      const status = statusOption(values.status);
      return {
        event: { type: "ticket.add", id, title, estimateMin, under, status: status?.status, closeReason: closeReasonOption(values["close-reason"]) ?? status?.closeReason, priority: priorityOption(values.priority), waitsFor, source, refs },
        message: `Added ${id}: ${title} (${estimateMin} min)${under ? `, under ${under}` : ""}${waitsFor ? `, waits for ${waitsFor}` : ""}${source ? `, source ${source.path ?? source.url}` : ""}${refs ? `, ref ${refs.join(", ")}` : ""}`,
      };
    },
  },
  "ticket update": {
    usage: `ticket update <id> [--status <status>] [--priority <0-4>] [--close-reason <done|skipped>] [--stage <name>] [--title <text>] [--estimate <minutes>] [--note <text>] [--waits-for <id>] [--source <path or http(s) URL>[=<label>]] [--ref <ref> ...]`,
    summary: `Change a ticket. Statuses: open, in_progress, blocked, closed; a close carries --close-reason done|skipped (default done). --priority is how urgent it is, 0-4. --stage names the step in progress, like Build or Fixes ("" clears it). --waits-for names a ticket it can't start before ("" clears it); waiting is not stuck, so don't mark it blocked for that. --source is where the ticket is written up ("" clears it). --ref is where the work came from; repeat it to replace all links at once.`,
    options: { status: { type: "string" }, priority: { type: "string" }, "close-reason": { type: "string" }, stage: { type: "string" }, title: { type: "string" }, estimate: { type: "string" }, note: { type: "string" }, "waits-for": { type: "string" }, source: { type: "string" }, ref: { type: "string", multiple: true } },
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
      const status = statusOption(values.status);
      const event = {
        type: "ticket.update" as const,
        id: ticket.id,
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
      if (!changes.length) throw new UsageError("Nothing to change. Pass --status, --priority, --stage, --title, --estimate, --note, --waits-for, --source, or --ref.");
      const shown = (value: unknown) => (typeof value === "object" && !Array.isArray(value) ? (value as FileLink).path ?? (value as FileLink).url : Array.isArray(value) ? value.join(", ") : value);
      return { event, message: `Updated ${ticket.id}: ${changes.map(([key, value]) => `${key} ${shown(value)}`).join(", ")}` };
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

const SHOW_SUMMARY = "Print the dashboard as text: what the user sees in the Progress panel. Flags: --mine (only your work), --all (every workspace), --json (machine-readable).";
const INSTALL_SUMMARY = "Write the paseo-progress launcher (default ~/.local/bin/paseo-progress). It runs this command from whichever copy of the plugin Paseo is running.";
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
    `  install-launcher [path]`,
    `      ${INSTALL_SUMMARY}`,
  ].join("\n");
}

export async function runCli(argv: string[], options: CliOptions): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  // The workspace id resolves once per call: every read and write in this
  // call scopes to it. No agent, or no record, is unscoped (All, as 0.4.0).
  const scope = options.agentId ? resolveWorkspaceId(options.agentId) : undefined;
  const [first, second] = argv;
  if (!first || first === "--help" || first === "-h" || first === "help") {
    out(help());
    return first ? 0 : 1;
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
        parsed = parseArgs({ args: argv.slice(1), options: { mine: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" } }, allowPositionals: true, strict: true });
      } catch (error) {
        out(`${(error as Error).message}\nUsage: ${USAGE_NAME} show [--mine] [--all] [--json]`);
        return 1;
      }
      const flags = { mine: parsed.values.mine === true, all: parsed.values.all === true, json: parsed.values.json === true };
      if (!flags.mine && !flags.all && !flags.json) {
        // Plain show: byte-identical to 0.4.0 for an unscoped call, and this
        // workspace's own board for a scoped one.
        const { dashboard } = await readProgress(store.directory, now(), scope);
        const added = addedByOthersText(addedByOthers(await readLatestRun(store.directory), dashboard, options.agentId), dashboard);
        out(`Worktree: ${root}\n\n${dashboardText(dashboard, now().getTime())}${added}`);
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
      if (flags.json) {
        out(JSON.stringify({ worktree: root, dashboard: view }, null, 2));
        return 0;
      }
      const added = flags.mine ? "" : addedByOthersText(addedByOthers(await readLatestRun(store.directory), view, options.agentId), view);
      out(`Worktree: ${root}\n\n${dashboardText(view, now().getTime())}${added}`);
      return 0;
    }
    const target = resolve(options.cwd, (argv[1] ?? DEFAULT_LAUNCHER).replace(/^~(?=$|\/)/, homedir()));
    out(await installLauncher(target) ? `Installed the launcher at ${target}` : `The launcher at ${target} is already current`);
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
      if (finished && command !== commands.start) {
        // No agent id means the unscoped board, whose latest run may be one
        // another workspace finished. A sandbox that strips PASEO_* variables
        // (context-mode's ctx_execute) lands an agent here; say so.
        const noId = options.agentId ? "" : " No PASEO_AGENT_ID reached this command, so it read the unscoped board. A Paseo agent runs it from its own shell, not a sandbox that strips PASEO_* variables.";
        throw new UsageError(`The run "${state.dashboard.run!.title}" is finished. Start new work with: ${USAGE_NAME} start "<title>".${noId}`);
      }
      const { event, message } = command.run({ positionals: parsed.positionals, values: parsed.values, state, cwd: options.cwd, root, scope });
      if (event.type === "ticket.update" && event.status === "closed") {
        const ticket = state.dashboard.tickets.find((candidate) => candidate.id === event.id);
        cascade = { refs: event.refs ?? ticket?.refs ?? [], reason: event.closeReason ?? "done" };
      }
      const added = command === commands.start ? "" : addedByOthersText(addedByOthers(state.events, state.dashboard, options.agentId), state.dashboard);
      return { event: { ...event, by: options.agentId, ws: scope }, result: `${message}${added}` };
    }, (text) => saveRunCopy(root, text), moveVerb ? UNION_SCOPE : scope);
    if (cascade && cascade.refs.length) {
      // Fail soft: the close already landed; a bd fault is logged, never fatal.
      const failures = await closeBackingBeads(root, cascade.refs, cascade.reason);
      for (const failure of failures) console.error(`cascade: could not close bead ${failure.id}: ${failure.message}`);
    }
    out(message);
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
