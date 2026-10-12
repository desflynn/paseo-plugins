// O-objectives (T07/T08/T09): o-number ids, the legacy-board display
// migration, names derived from --ref linkage, the Beads vocabulary and the
// nested tree. Fold tests build JSONL text like scoping.test.ts; command
// tests run the real CLI in a throwaway worktree like progress.test.ts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { displayId, parseProgress, reduceProgress, sortObjectives, compareBeads, beadsToFold, beadDoneLabel, rowTone, ticketDepth, ticketRefs, githubIssueUrl, ticketName, type Ticket } from "../shared/dashboard.ts";
import { runCli } from "./cli.ts";
import { readProgress } from "./progress-file.ts";
import { outsideDirectory } from "./store.ts";

// Real repos in these tests; the user's own git config stays out of them.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Working files live under the home folder, so each test run gets its own.
process.env.HOME = await mkdtemp(join(tmpdir(), "progress-home-o-"));

const T0 = Date.parse("2026-09-27T19:59:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const NOW = new Date(T0 + 2 * 60_000);

const line = (event: Record<string, unknown>, minute = 0) => JSON.stringify({ v: 1, ts: at(minute), ...event });

function fold(text: string, scope?: string) {
  return reduceProgress(parseProgress(text), NOW, scope);
}

const add = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  line({ type: "ticket.add", id, title, estimateMin: 60, ...extra });

// A compact version of progress.test.ts's harness: real commands in a
// throwaway worktree, the dashboard the panel would get.
async function worktree(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "progress-o-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await promisify(execFile)("git", ["init", "-q"], { cwd: directory });
  const store = outsideDirectory(directory);
  let clock = 0;
  const output: string[] = [];
  return {
    directory,
    store,
    output,
    at(minute: number) { clock = minute; },
    async run(...argv: string[]) {
      output.length = 0;
      const code = await runCli(argv, { cwd: directory, now: () => new Date(T0 + clock * 60_000), out: (entry) => output.push(entry) });
      return { code, text: output.join("\n") };
    },
    // The last event the commands wrote, for pinning what exactly lands in the file.
    async lastEvent() {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(join(store, "progress.jsonl"), "utf8");
      const lines = text.split("\n").filter((entry) => entry.trim());
      return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    },
    dashboard: (minute = clock) => readProgress(store, new Date(T0 + minute * 60_000)),
  };
}

// ── T07: o-number ids ────────────────────────────────────────────────────────

test("legacy T-ids display as o-ids in board order: T01→o1 through T15→o15", () => {
  const legacy = Array.from({ length: 15 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`);
  const text = [
    line({ type: "run.start", title: "Fork follow-ups" }),
    ...legacy.map((id, index) => add(id, `Objective ${index + 1}`)),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  // The full mapping, pinned: position number, no zero padding, nothing else moves.
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.id), legacy.map((_, index) => `o${index + 1}`));
  assert.equal(dashboard.tickets[6].title, "Objective 7", "T07 keeps its title through the migration");
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.estimateMin), legacy.map(() => 60));
});

test("displayId maps legacy ids and passes everything else through", () => {
  assert.equal(displayId("T01"), "o1");
  assert.equal(displayId("T15"), "o15");
  assert.equal(displayId("t07"), "o7");
  assert.equal(displayId("o1"), "o1");
  assert.equal(displayId("o1.1.2"), "o1.1.2");
});

test("updates, removes and waits-for on legacy ids land on the migrated ticket", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "First"),
    add("T02", "Second"),
    add("T03", "Third", { waitsFor: "T01" }),
    line({ type: "ticket.update", id: "T01", status: "working" }),
    line({ type: "ticket.remove", id: "T02" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  const first = dashboard.tickets.find((ticket) => ticket.id === "o1")!;
  assert.ok(first, "T01 folds to o1");
  assert.equal(first.status, "in_progress", "the update by legacy id reached it");
  assert.equal(dashboard.tickets.some((ticket) => ticket.id === "o2"), false, "T02 was removed by its legacy id");
  const third = dashboard.tickets.find((ticket) => ticket.id === "o3")!;
  assert.equal(third.waitingFor?.id, "o1", "a waits-for on a legacy id resolves to the migrated id");
});

test("the next id continues the o-series: after T01..T15 it mints o16, a fresh run starts at o1", () => {
  const legacy = Array.from({ length: 15 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`);
  const text = [
    line({ type: "run.start", title: "Run one" }),
    ...legacy.map((id, index) => add(id, `Objective ${index + 1}`)),
    "",
  ].join("\n");
  assert.equal(fold(text).nextIds.ticket, "o16");
  // A new run's board is empty, so it starts over at o1, like T-ids did.
  const fresh = [line({ type: "run.start", title: "Run two", ts: at(1) }), ""].join("\n");
  assert.equal(fold(fresh).nextIds.ticket, "o1");
  // A mixed run counts both vocabularies: T01 is o1, so with o5 present, next is o6.
  const mixed = [line({ type: "run.start", title: "Run" }), add("T01", "Legacy"), add("o5", "Objective"), ""].join("\n");
  assert.equal(fold(mixed).nextIds.ticket, "o6");
});

test("removed tickets' numbers are never reused", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "First"),
    line({ type: "ticket.remove", id: "T01" }),
    "",
  ].join("\n");
  assert.equal(fold(text).nextIds.ticket, "o2");
});

// ── T07: names derived from linkage ──────────────────────────────────────────

test("the name composes from the id, the bead slug and the gh issue number", () => {
  const both: Ticket = { id: "o1.1", title: "Fix the widget", estimateMin: 60, status: "open", statusSince: at(0), history: [], ref: "bead:paseo-plugins-ti5", refs: ["gh:paseo-plugins/ti5#42"] };
  assert.equal(ticketName(both), "o1.1-paseo-plugins-ti5-42 Fix the widget");
  const beadOnly: Ticket = { id: "o1.1", title: "Fix the widget", estimateMin: 60, status: "open", statusSince: at(0), history: [], ref: "bead:paseo-plugins-ti5" };
  assert.equal(ticketName(beadOnly), "o1.1-paseo-plugins-ti5 Fix the widget", "parts appear only when present");
  const plain: Ticket = { id: "o1.1", title: "Fix the widget", estimateMin: 60, status: "open", statusSince: at(0), history: [] };
  assert.equal(ticketName(plain), "Fix the widget", "no bead: plain id and title");
  const otherRef: Ticket = { id: "o1", title: "Chase it", estimateMin: 60, status: "open", statusSince: at(0), history: [], ref: "teams:abc123" };
  assert.equal(ticketName(otherRef), "o1 Chase it", "refs with no name part still separate id from title");
});

test("re-linking updates the derived name automatically", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Fix the widget", { ref: "bead:old-slug" }),
    line({ type: "ticket.update", id: "T01", ref: "bead:new-slug" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  assert.equal(ticketName(dashboard.tickets[0]), "o1-new-slug Fix the widget");
});

test("legacy tickets without refs keep their title untouched", () => {
  const { dashboard } = fold([line({ type: "run.start", title: "Run" }), add("T01", "Ticket 01: Frozen links survive deletes"), ""].join("\n"));
  assert.equal(ticketName(dashboard.tickets[0]), "Ticket 01: Frozen links survive deletes");
});

// ── T07: the live surface ────────────────────────────────────────────────────

test("the CLI mints o-ids and show prints them with the composed name", async (t) => {
  const w = await worktree(t);
  await w.run("start", "O-objectives");
  const added = await w.run("ticket", "add", "Fix the widget", "--estimate", "30", "--ref", "bead:ti5", "--ref", "gh:acme/widgets#42");
  assert.match(added.text, /Added o1: /);
  assert.match((await w.run("ticket", "add", "Second", "--estimate", "15")).text, /Added o2: /);
  const show = await w.run("show");
  assert.match(show.text, /o1 {2}\S.* {2}30 min {2}o1-ti5-42 Fix the widget/);
  assert.match(show.text, /^  o2 {2}\S.* {2}15 min {2}Second$/m);
});

test("tickets answer to their o-id and their legacy T-id", async (t) => {
  const w = await worktree(t);
  await w.run("start", "O-objectives");
  await w.run("ticket", "add", "Fix the widget", "--estimate", "30");
  assert.match((await w.run("ticket", "claim", "o1")).text, /Claimed o1: /);
  assert.match((await w.run("ticket", "done", "T01")).text, /Done o1: /, "the legacy T-form still addresses the migrated ticket");
  const { dashboard } = await w.dashboard();
  assert.equal(dashboard.tickets[0].status, "closed");
  assert.equal(dashboard.tickets[0].closeReason, "done");
});

test("deliverables and questions tagged with legacy ids stay attached to the migrated ticket", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "First"),
    line({ type: "deliverable.add", id: "D1", title: "Proof", path: "proof.md", ticket: "T01" }),
    line({ type: "activity.add", id: "A1", text: "Started", ticket: "T01" }),
    line({ type: "question.ask", id: "Q1", title: "Shape", question: "Round or square?", recommend: "Round", ticket: "T01" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  assert.equal(dashboard.deliverables[0].ticketId, "o1");
  assert.equal(dashboard.deliverables[0].ticketLabel, "First", "the label shortens the ticket's own title");
  assert.equal(dashboard.activity[0].ticketId, "o1");
  assert.equal(dashboard.questions.open[0].ticketId, "o1");
});

// ── T09: nested objectives ──────────────────────────────────────────────────────

test("a ticket can sit under another, and the fold carries the parent migrated", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Parent"),
    add("o1.1", "Child", { under: "T01" }),
    add("o1.1.1", "Grandchild", { under: "o1.1" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  const byId = (id: string) => dashboard.tickets.find((ticket) => ticket.id === id)!;
  assert.equal(byId("o1.1").under, "o1", "a legacy under migrates to the o-form");
  assert.equal(byId("o1.1.1").under, "o1.1");
  assert.equal(byId("o1").under, undefined);
});

test("the CLI mints child ids with --under, any depth, and never reuses a removed number", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Tree");
  await w.run("ticket", "add", "Epic", "--estimate", "60");
  assert.match((await w.run("ticket", "add", "First child", "--estimate", "30", "--under", "o1")).text, /Added o1\.1: /);
  assert.match((await w.run("ticket", "add", "Second child", "--estimate", "30", "--under", "o1")).text, /Added o1\.2: /);
  assert.match((await w.run("ticket", "add", "Grandchild", "--estimate", "15", "--under", "o1.1")).text, /Added o1\.1\.1: /);
  await w.run("ticket", "remove", "o1.2");
  assert.match((await w.run("ticket", "add", "Replacement", "--estimate", "30", "--under", "o1")).text, /Added o1\.3: /, "the removed child's number stays spent");
  const bad = await w.run("ticket", "add", "Orphan", "--estimate", "15", "--under", "o9");
  assert.equal(bad.code, 1);
  assert.match(bad.text, /No ticket o9/);
  const { dashboard } = await w.dashboard();
  const child = dashboard.tickets.find((ticket) => ticket.id === "o1.1.1")!;
  assert.equal(child.under, "o1.1");
});

test("objectives sort by numeric slug, o2 above o10, and closed ones sink", () => {
  const make = (id: string, status: Ticket["status"] = "open", priority?: number): Ticket => ({ id, title: "", estimateMin: 10, status, statusSince: at(0), history: [], priority });
  const list = [make("o10"), make("o2"), make("o1.1"), make("o1"), make("o1.1.2"), make("o3", "closed")];
  assert.deepEqual(sortObjectives(list).map((ticket) => ticket.id), ["o1", "o1.1", "o1.1.2", "o2", "o10", "o3"], "slug order with the closed ticket sunk below the open ones");
  const ranked = [make("o1", "open", 2), make("o2"), make("o3", "open", 0), make("o4", "open", 0), make("o3.1", "open", 1), make("o3.2", "open", 0), make("o1.1", "open", 0), make("o5", "closed", 0)];
  assert.deepEqual(sortObjectives(ranked).map((ticket) => ticket.id), ["o3", "o3.2", "o3.1", "o4", "o1", "o1.1", "o2", "o5"], "P0 first, then P1 to P4, no priority last; o-number ascending in a band; children sort the same way under their parent; closed sink");
  assert.equal(sortObjectives([make("o2"), make("o1", "open", 4)])[0].id, "o1", "P4 still sits above no priority");
  const running = [make("o5", "open", 0), make("o7", "in_progress", 0), make("o6", "blocked", 0), make("o9", "in_progress", 1), make("o8", "open", 1)];
  assert.deepEqual(sortObjectives(running).map((ticket) => ticket.id), ["o7", "o5", "o6", "o9", "o8"], "inside a band in-progress goes first, then o-number; a P1 in progress still sits below every P0");
  const family = [make("o1", "open", 0), make("o1.1"), make("o1.2", "in_progress"), make("o1.3")];
  assert.deepEqual(sortObjectives(family).map((ticket) => ticket.id), ["o1", "o1.2", "o1.1", "o1.3"], "children follow the same rule under their parent");
  assert.equal(ticketDepth(make("o1.1.2")), 2);
  assert.equal(ticketDepth(make("o1")), 0);
});

test("the linkage parses into chips: the bead slug and the GitHub issue", () => {
  const both: Ticket = { id: "o1.1", title: "", estimateMin: 10, status: "open", statusSince: at(0), history: [], ref: "bead:paseo-plugins-ti5", refs: ["gh:desflynn/widgets#42"] };
  assert.deepEqual(ticketRefs(both), { bead: "paseo-plugins-ti5", gh: { owner: "desflynn", repo: "widgets", number: 42 } });
  assert.equal(githubIssueUrl({ owner: "desflynn", repo: "widgets", number: 42 }), "https://github.com/desflynn/widgets/issues/42");
  const none: Ticket = { id: "o1", title: "", estimateMin: 10, status: "open", statusSince: at(0), history: [] };
  assert.deepEqual(ticketRefs(none), {});
});

// ── T08: the Beads vocabulary ───────────────────────────────────────────────────────

test("legacy statuses fold to the Beads vocabulary: open, in_progress, closed with a reason", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Untouched"),
    add("T02", "Begun", { status: "working" }),
    add("T03", "Finished", { status: "done" }),
    add("T04", "Dropped", { status: "skipped" }),
    add("T05", "Held", { status: "blocked" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  const byId = (id: string) => dashboard.tickets.find((ticket) => ticket.id === id)!;
  assert.equal(byId("o1").status, "open");
  assert.equal(byId("o2").status, "in_progress");
  assert.equal(byId("o2").startedAt, at(0), "started-at is set when work begins");
  assert.equal(byId("o3").status, "closed");
  assert.equal(byId("o3").closeReason, "done");
  assert.equal(byId("o4").status, "closed");
  assert.equal(byId("o4").closeReason, "skipped");
  assert.equal(byId("o5").status, "blocked", "blocked stays the ticket system's stuck mark");
});

test("a status change keeps started-at honest: set on beginning, kept through the close", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "First"),
    line({ type: "ticket.update", id: "T01", status: "working" }, 1),
    line({ type: "ticket.update", id: "T01", status: "done" }, 2),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  const ticket = dashboard.tickets[0];
  assert.equal(ticket.status, "closed");
  assert.equal(ticket.closeReason, "done");
  assert.equal(ticket.startedAt, at(1), "the moment work began, not the close");
});

test("the CLI writes canonical values: open, in_progress, closed with a reason", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Vocabulary");
  await w.run("ticket", "add", "First", "--estimate", "30");
  assert.equal((await w.lastEvent()).status, undefined, "a plain add carries no status; the fold opens it");
  await w.run("ticket", "claim", "o1");
  assert.equal((await w.lastEvent()).status, "in_progress");
  await w.run("ticket", "done", "o1");
  const closed = await w.lastEvent();
  assert.equal(closed.status, "closed");
  assert.equal(closed.closeReason, "done");
  await w.run("ticket", "add", "Second", "--estimate", "15");
  await w.run("ticket", "update", "o2", "--status", "closed", "--close-reason", "skipped", "--note", "not worth it");
  const skipped = await w.lastEvent();
  assert.equal(skipped.status, "closed");
  assert.equal(skipped.closeReason, "skipped");
  // The old words keep working as aliases, written canonically.
  await w.run("ticket", "add", "Third", "--estimate", "15");
  await w.run("ticket", "update", "o3", "--status", "skipped");
  const alias = await w.lastEvent();
  assert.equal(alias.status, "closed");
  assert.equal(alias.closeReason, "skipped");
});

test("priority is a number 0-4, settable at add and update, refused outside the range", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Vocabulary");
  await w.run("ticket", "add", "Urgent", "--estimate", "30", "--priority", "1");
  assert.equal((await w.lastEvent()).priority, 1);
  await w.run("ticket", "update", "o1", "--priority", "0");
  assert.equal((await w.lastEvent()).priority, 0, "zero is a valid priority");
  const bad = await w.run("ticket", "update", "o1", "--priority", "5");
  assert.equal(bad.code, 1);
  assert.match(bad.text, /--priority must be a number from 0 to 4/);
  const fraction = await w.run("ticket", "add", "Bad", "--estimate", "30", "--priority", "2.5");
  assert.equal(fraction.code, 1);
});

test("the vocabulary keeps the math honest: progress counts closed done, skips closed skipped, overdue still fires", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Done", { status: "done", estimateMin: 60 }),
    add("T02", "Skipped", { status: "skipped", estimateMin: 60 }),
    add("T03", "Stalled", { status: "working", estimateMin: 30 }),
    "",
  ].join("\n");
  const NOW_LATE = new Date(T0 + 120 * 60_000);
  const { dashboard } = reduceProgress(parseProgress(text), NOW_LATE);
  assert.equal(dashboard.progress.totalMin, 90, "the closed-skipped ticket leaves the totals");
  assert.equal(dashboard.progress.doneMin, 60);
  assert.equal(dashboard.progress.percent, 67);
  assert.deepEqual(dashboard.stuck.map((item) => item.kind), ["overdue"], "the in_progress ticket still goes overdue");
  assert.equal(dashboard.stuck[0].ticketId, "o3");
});

// ── O2600 (o17): one shared list ─────────────────────────────────────
// The three panel views (objectives, beads, GH issues) render through one
// list, one row style, one done-sink. These are the pure pieces the tree
// tests pin; the panel glue is typed by typecheck.
const bead = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title: `Bead ${id}`, status, ...extra });

test("rowTone splits running from potential: only in_progress runs full-strength", () => {
  assert.equal(rowTone("in_progress"), "running");
  for (const status of ["open", "blocked", "deferred", "closed"]) {
    assert.equal(rowTone(status), "potential", `${status} is not running`);
  }
});

test("beads sort open-first, then priority 0 (most urgent) to 4, then id", () => {
  const list = [
    bead("pp-1", "open", { priority: 1 }),
    bead("pp-9", "closed"),
    bead("pp-3", "open", { priority: 3 }),
    bead("pp-2", "open"),
  ];
  assert.deepEqual([...list].sort(compareBeads).map((entry) => entry.id), ["pp-1", "pp-3", "pp-2", "pp-9"], "priority orders the open beads; the closed bead sinks");
  const tied = [bead("pp-b", "open", { priority: 2 }), bead("pp-a", "open", { priority: 2 })];
  assert.deepEqual([...tied].sort(compareBeads).map((entry) => entry.id), ["pp-a", "pp-b"], "ties break by id");
});

test("beads fold like the objectives' done-sink: two or more closed and open work remains", () => {
  const one = [bead("pp-1", "open"), bead("pp-9", "closed")];
  assert.deepEqual(beadsToFold(one), [], "a single closed bead isn't worth a fold row");
  const two = [bead("pp-1", "open"), bead("pp-8", "closed"), bead("pp-9", "closed")];
  assert.deepEqual(beadsToFold(two).map((entry) => entry.id), ["pp-8", "pp-9"]);
  const all = [bead("pp-8", "closed"), bead("pp-9", "closed")];
  assert.deepEqual(beadsToFold(all), [], "everything closed: the whole list is the record, nothing folds");
});

test("the fold count label reads done and skipped off the close reasons", () => {
  assert.equal(beadDoneLabel([bead("a", "closed", { close_reason: "done" }), bead("b", "closed")]), "2 done", "a closed bead without a recorded reason reads as done");
  assert.equal(beadDoneLabel([bead("a", "closed", { close_reason: "skipped" })]), "1 skipped");
  assert.equal(beadDoneLabel([bead("a", "closed"), bead("b", "closed", { close_reason: "skipped" })]), "1 done, 1 skipped");
});
