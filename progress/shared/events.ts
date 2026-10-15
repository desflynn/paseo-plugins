import { z } from "zod";

// One line of `progress.jsonl`. The command-line tool writes these; the
// dashboard reducer reads them. `v` lets later versions change a shape without
// misreading old files. Which folder holds it is set up per repo.
export const PROGRESS_FILE_NAME = "progress.jsonl";
// Present once someone has opened the Progress panel for this worktree.
export const PANEL_OPENED_NAME = "progress-panel-opened";
// Where 0.1.x kept each worktree's files. store.ts moves them out.
export const LEGACY_FOLDER = ".scratch";
export const EVENT_VERSION = 1;

// The Beads vocabulary (O1700): open/closed with a close reason (done,
// skipped), started-at when work begins. These four are what the fold stores.
export const TICKET_STATUSES = ["open", "in_progress", "blocked", "closed"] as const;
export type BoardStatus = (typeof TICKET_STATUSES)[number];
export const CLOSE_REASONS = ["done", "skipped"] as const;
// Live: work is outstanding. Keepalive: only the cache keep-alive nudge is pending.
export const CONN_MODES = ["live", "keepalive"] as const;
export type ConnMode = (typeof CONN_MODES)[number];
export type CloseReason = (typeof CLOSE_REASONS)[number];
// What events may carry: the canonical words plus the 0.4.0 ones, which the
// fold translates, so historical files parse forever.
export const ticketStatusSchema = z.enum([...TICKET_STATUSES, "not_started", "working", "done", "skipped"]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

const text = z.string().trim().min(1);
const minutes = z.number().int().positive().max(100_000);
// `by` is the Paseo agent that wrote the event, absent when run outside Paseo.
// `ws` is the Paseo workspace id, absent when unknown or run outside Paseo.
const base = { v: z.literal(EVENT_VERSION), ts: z.iso.datetime(), by: text.optional(), ws: text.optional() };

export const questionOptionSchema = z.object({
  letter: z.string().regex(/^[A-Z]$/),
  label: text,
  consequence: text.optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

const httpUrl = z.url().refine((value) => /^https?:\/\//i.test(value), "Use an HTTP or HTTPS URL");

// Something attached to a question: a local path or a web link.
export const fileLinkSchema = z
  .object({ path: text.optional(), url: httpUrl.optional(), label: text.optional() })
  .refine((file) => Boolean(file.path) !== Boolean(file.url), "Give a path or a URL");
export type FileLink = z.infer<typeof fileLinkSchema>;

export const DELIVERABLE_KINDS = ["file", "folder", "report", "screenshot", "link"] as const;

export const eventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("run.start"),
    title: text,
    subtitle: text.optional(),
    itemLabel: text.optional(),
  }),
  // Closes the run. Nothing more is recorded on it; new work needs `run.start`.
  z.object({ ...base, type: z.literal("run.finish"), outcome: text }),
  // Renames the run in place: a correction, not a new run. Each field applies
  // when present; an empty subtitle clears it. Tickets and history are untouched.
  z.object({ ...base, type: z.literal("run.rename"), title: text.optional(), subtitle: z.string().trim().optional() }),
  z.object({
    ...base,
    type: z.literal("ticket.add"),
    id: text,
    title: text,
    estimateMin: minutes,
    status: ticketStatusSchema.optional(),
    // Why it closed: only meaningful with status "closed".
    closeReason: z.enum(CLOSE_REASONS).optional(),
 // How urgent it is, Beads-style: 0 is lowest, 4 highest.
    priority: z.number().int().min(0).max(4).optional(),
    // Another ticket in the run this one can't start until it's done.
    waitsFor: text.optional(),
    // Where the ticket is written up: a spec file or an issue link.
    source: fileLinkSchema.optional(),
    // Where the work came from: `bead:<id>`, `gh:<owner>/<repo>#<n>` or `teams:<messageId>`.
    ref: text.optional(),
    // Newer tickets carry several refs at once (a bead and its GitHub issue);
    // older events carry the single `ref`. Both stay readable forever.
    refs: z.array(text).optional(),
    // The parent objective, when this one is nested (O1800). Any depth.
    under: text.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("ticket.update"),
    id: text,
    title: text.optional(),
    estimateMin: minutes.optional(),
    status: ticketStatusSchema.optional(),
    // Why it closed, when closing or re-closing.
    closeReason: z.enum(CLOSE_REASONS).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    // The step inside the ticket, like "Build" or "Fixes". Empty clears it.
    stage: z.string().trim().optional(),
    note: z.string().trim().optional(),
    // Empty clears it.
    waitsFor: z.string().trim().optional(),
    // Empty clears it.
    source: z.union([fileLinkSchema, z.literal("")]).optional(),
    // Where the work came from: `bead:<id>`, `gh:<owner>/<repo>#<n>` or `teams:<messageId>`.
    ref: text.optional(),
    // Replaces the ticket's refs when given (see ticket.add).
    refs: z.array(text).optional(),
    // Moves the ticket under another (and its children with it); empty lifts it
    // back to the top level. The id never changes: the tree is this field.
    under: z.string().trim().optional(),
  }),
  z.object({ ...base, type: z.literal("ticket.remove"), id: text }),
  // A reallocation correction (o21): from here on the ticket renders on the
  // `to` workspace only (and --all). Append-only — the fold honours it at
  // read time, nothing is rewritten — and children follow the parent.
  z.object({ ...base, type: z.literal("ticket.move"), id: text, to: text }),
  // A blocker that is not a ticket status, like a failing external service.
  z.object({ ...base, type: z.literal("stuck.set"), id: text, reason: text, ticket: text.optional() }),
  z.object({ ...base, type: z.literal("stuck.clear"), id: text }),
  // The agent asks, recommends an option, and builds none of them before the
  // answer: it works only on what the question doesn't affect. Older questions
  // carry `default` (the option the agent carried on with) and `waits` instead.
  z.object({
    ...base,
    type: z.literal("question.ask"),
    id: text,
    title: text,
    question: text,
    options: z.array(questionOptionSchema).max(26).optional(),
    // The agent's pick: an option letter, or a word such as "Looks right" when there are no options.
    recommend: text.optional(),
    default: text.optional(),
    waits: z.boolean().optional(),
    background: text.optional(),
    files: z.array(fileLinkSchema).optional(),
    raisedBy: text.optional(),
    // The ticket this question came up on.
    ticket: text.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("question.answer"),
    id: text,
    choice: text,
    // The user's own words, quoted under the answer.
    words: text.optional(),
    // Older answers: true when the agent had to undo work built on its default.
    changedCourse: z.boolean().optional(),
  }),
  // Adds detail to an open question; its reference and default stay.
  z.object({
    ...base,
    type: z.literal("question.update"),
    id: text,
    question: text.optional(),
    background: text.optional(),
    files: z.array(fileLinkSchema).optional(),
  }),
  z.object({ ...base, type: z.literal("question.remove"), id: text }),
  // `path` is relative to the worktree root, or absolute when outside it.
  z.object({
    ...base,
    type: z.literal("deliverable.add"),
    id: text,
    title: text,
    path: text.optional(),
    url: httpUrl.optional(),
    ticket: text.optional(),
    kind: z.enum(DELIVERABLE_KINDS).optional(),
  }).refine((event) => Boolean(event.path) !== Boolean(event.url), "A deliverable has a path or a URL"),
  z.object({ ...base, type: z.literal("deliverable.remove"), id: text }),
  z.object({ ...base, type: z.literal("activity.add"), id: text, text, ticket: text.optional() }),
  z.object({ ...base, type: z.literal("activity.update"), id: text, text }),
  z.object({ ...base, type: z.literal("activity.remove"), id: text }),
  // One line at the top saying what the agent is doing right now.
  z.object({ ...base, type: z.literal("ticker.set"), text }),
  z.object({ ...base, type: z.literal("ticker.clear") }),
  // Conn ("full auto") is state the DCI engine owns and rewrites on every nudge
  // and state change; the board stores and displays it, and decides nothing.
  // `since` is derived in the fold: the first set after the last clear.
  z.object({ ...base, type: z.literal("conn.set"), budget: z.number().int().positive(), mode: z.enum(CONN_MODES), nextNudgeAt: z.iso.datetime(), clear: z.literal(true).optional() }),
  z.object({ ...base, type: z.literal("conn.clear") }),
]);

export type ProgressEvent = z.infer<typeof eventSchema>;
export type ProgressEventType = ProgressEvent["type"];
