// Workspace scoping: two Paseo workspaces on one checkout each fold to their
// own run, a late unscoped start displaces neither, and a file with no `ws`
// folds exactly as 0.4.0 did. Also: `ref` carried onto Ticket; a
// no-workspace writer's same-id add shadows no workspace's own ticket (D-4)
// while a no-ws update still reaches a ws-tagged ticket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProgress, reduceProgress, UNION_SCOPE } from "../shared/dashboard.ts";

const T0 = Date.parse("2026-09-27T19:59:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const NOW = new Date(T0 + 2 * 60_000);

const line = (event: Record<string, unknown>) => JSON.stringify({ v: 1, ts: at(0), ...event });

function fold(text: string, scope?: string, agentWs?: ReadonlyMap<string, string>) {
  return reduceProgress(parseProgress(text), NOW, scope, agentWs);
}

// The agent→workspace map, as the server would hand it over from the Paseo
// agent registry (o20).
const AGENTS = new Map<string, string>([["agent-a", "ws-a"], ["agent-b", "ws-b"]]);
const foldWith = (text: string, scope?: string) => fold(text, scope, AGENTS);

const add = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  line({ type: "ticket.add", id, title, estimateMin: 60, ...extra });

test("two workspaces on one checkout each fold to their own run; neither board goes empty", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T02", "B ticket", { ws: "ws-b" }),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  const b = fold(text, "ws-b");
  assert.equal(a.dashboard.run?.title, "Workspace A");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.title), ["A ticket"]);
  assert.equal(a.dashboard.progress.totalMin, 60);
  assert.equal(b.dashboard.run?.title, "Workspace B");
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.title), ["B ticket"]);
  assert.equal(b.dashboard.progress.totalMin, 60);
});

test("each workspace mints its own next ticket id from its own run", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  const b = fold(text, "ws-b");
  assert.equal(a.nextIds.ticket, "o2");
  // B's run has no tickets of its own, so it mints T01 even though A used it.
  assert.equal(b.nextIds.ticket, "o1");
});

test("a late unscoped run.start displaces neither workspace's run", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    line({ type: "run.start", title: "Late unscoped" }),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  const b = fold(text, "ws-b");
  assert.ok(a.dashboard.run, "workspace A lost its run slot");
  assert.ok(a.dashboard.tickets.some((ticket) => ticket.id === "o1"), "workspace A's board was emptied");
  assert.ok(b.dashboard.run, "workspace B lost its run slot");
});

test("legacy events with no ws stay visible inside a scoped run", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "Legacy ticket"),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.id), ["o1"]);
});

test("a file with no ws anywhere folds on the no-scope path exactly as 0.4.0: last run.start wins", () => {
  const text = [
    line({ type: "run.start", title: "Old run" }),
    add("T90", "Old ticket"),
    line({ type: "run.start", title: "New run" }),
    add("T01", "New ticket"),
    "",
  ].join("\n");
  const all = fold(text);
  assert.equal(all.dashboard.run?.title, "New run");
  assert.deepEqual(all.dashboard.tickets.map((ticket) => ticket.id), ["o1"]);
  assert.equal(all.nextIds.ticket, "o2");
});

test("with no scope the boundary is the last run.start in the file, whatever ws it carries", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T02", "B ticket", { ws: "ws-b" }),
    "",
  ].join("\n");
  const all = fold(text);
  assert.equal(all.dashboard.run?.title, "Workspace B");
  assert.deepEqual(all.dashboard.tickets.map((ticket) => ticket.id), ["o2"]);
});

test("ref carries onto the Ticket and updates with ticket.update", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "From a bead", { ref: "bead:rvr-1" }),
    line({ type: "ticket.update", id: "T01", ref: "gh:o/r#7" }),
    add("T02", "No ref given"),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  const fromBead = dashboard.tickets.find((ticket) => ticket.id === "o1");
  assert.equal(fromBead?.ref, "gh:o/r#7");
  const noRef = dashboard.tickets.find((ticket) => ticket.id === "o2");
  assert.equal(noRef?.ref, undefined);
});

// OWNER UNION (revision 5): the union fold — every scope's current run folds
// together into one board. All tickets visible, counts and percent over the
// union, ids minted per scope may repeat and both show.
const unionFold = (text: string) => fold(text, UNION_SCOPE);

test("union folds every scope's current run into one board with honest counts", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a", status: "done" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T01", "B ticket", { ws: "ws-b" }),
    "",
  ].join("\n");
  const { dashboard } = unionFold(text);
  assert.equal(dashboard.tickets.length, 2, "both runs' tickets show");
  assert.equal(dashboard.progress.totalMin, 120, "counts over the union");
  assert.equal(dashboard.progress.doneMin, 60);
  assert.equal(dashboard.progress.percent, 50, "percent over the union");
  assert.ok(dashboard.tickets.every((ticket) => ticket.ws), "each union ticket names its workspace");
});

test("ids minted per scope may repeat and both show", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T01", "B ticket", { ws: "ws-b" }),
    "",
  ].join("\n");
  const { dashboard } = unionFold(text);
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.id).sort(), ["o1", "o1"], "both T01s show");
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.title).sort(), ["A ticket", "B ticket"]);
});

// GPG's board (dci-harness): his workspace stamps its work but never started
// a run of its own, so the union, which only walked run.start scopes, left
// all of it out. A workspace with stamped work joins the union with the
// same slice its own WS view shows.
test("a workspace with stamped work but no run of its own still shows in the union", () => {
  const text = [
    line({ type: "run.start", title: "Shared run" }),
    add("T01", "B's work", { ws: "ws-b" }),
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A's work", { ws: "ws-a" }),
    "",
  ].join("\n");
  const titles = unionFold(text).dashboard.tickets.map((ticket) => ticket.title).sort();
  assert.deepEqual(titles, ["A's work", "B's work"], "B's stamped work is missing from All");
  assert.deepEqual(fold(text, "ws-b").dashboard.tickets.map((ticket) => ticket.title), ["B's work"], "B's own view is unchanged");
});

test("a file with no ws anywhere folds the union exactly like 0.4.0", () => {
  const text = [
    line({ type: "run.start", title: "Old run" }),
    add("T90", "Old ticket"),
    line({ type: "run.start", title: "New run" }),
    add("T01", "New ticket"),
    "",
  ].join("\n");
  const union = unionFold(text);
  const legacy = fold(text);
  assert.equal(union.dashboard.run?.title, "New run");
  assert.deepEqual(union.dashboard.tickets.map((ticket) => ticket.id), ["o1"]);
  assert.equal(union.nextIds.ticket, legacy.nextIds.ticket);
  assert.deepEqual(union.dashboard.tickets, legacy.dashboard.tickets);
});

test("an unscoped event shared by two scoped runs appears once in the union", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T05", "Legacy shared ticket"),
    add("T02", "B ticket", { ws: "ws-b" }),
    "",
  ].join("\n");
  const { dashboard } = unionFold(text);
  const titles = dashboard.tickets.map((ticket) => ticket.title).sort();
  assert.deepEqual(titles, ["A ticket", "B ticket", "Legacy shared ticket"], "three tickets, no duplicates");
});

// PROOF FIXES (revision 7), from CHECKPILOT's proof run 1: D-2 and D-1.

test("a run with no ws continued by a ws writer folds honestly in the union (D-2)", () => {
  // 0.4.0 started this run before the swap; a ws-tagged agent continues it.
  // The union must treat the continuation as part of that run whatever ws the
  // later events carry: show --all and the workspace show agree on statuses,
  // counts, and no skipped lines.
  const text = [
    line({ type: "run.start", title: "Legacy run" }),
    add("T01", "First ticket"),
    add("T02", "Second ticket"),
    line({ type: "ticket.update", id: "T01", status: "done", ws: "ws-a" }),
    "",
  ].join("\n");
  const union = unionFold(text);
  const workspace = fold(text, "ws-a");
  assert.deepEqual(
    union.dashboard.tickets.map((ticket) => [ticket.id, ticket.status]),
    workspace.dashboard.tickets.map((ticket) => [ticket.id, ticket.status]),
    "union and workspace views disagree",
  );
  assert.equal(union.dashboard.progress.doneMin, 60);
  assert.equal(union.dashboard.progress.totalMin, 120);
  assert.equal(union.dashboard.progress.percent, 50);
  assert.deepEqual(union.dashboard.issues, [], "skipped lines in the union");
  assert.deepEqual(workspace.dashboard.issues, []);
  // And two scopes' same-id T01s still both show.
  const both = unionFold([
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T01", "B ticket", { ws: "ws-b" }),
    "",
  ].join("\n"));
  assert.deepEqual(both.dashboard.tickets.map((ticket) => ticket.title).sort(), ["A ticket", "B ticket"]);
});

test("a stray unscoped run.start claims no header in a scope with its own run (D-1)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T02", "B ticket", { ws: "ws-b" }),
    line({ type: "run.start", title: "Stray unscoped run" }),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  const b = fold(text, "ws-b");
  const union = unionFold(text);
  assert.equal(a.dashboard.run?.title, "Workspace A", "stray displaced A's title");
  assert.equal(b.dashboard.run?.title, "Workspace B", "stray displaced B's title");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.id), ["o1"]);
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.id), ["o2"]);
  assert.equal(union.dashboard.run?.title, "Workspace B", "stray displaced the union header");
});

// DEFECT D-4 (O1000, owner ruling: change the fold): a no-workspace writer's
// same-id ticket.add must not take a scoped ticket's place on any workspace
// board or in the union. Design A.5: a miss is safe. The unscoped writer's
// own plain fold (no scope) is untouched — it still shows its own run.
test("an unscoped writer's same-id add shadows no workspace's ticket (D-4)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A one", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T01", "B one", { ws: "ws-b" }),
    line({ type: "run.start", title: "Unresolved run" }),
    add("T01", "Unscoped one"),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  const b = fold(text, "ws-b");
  const union = unionFold(text);
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.title), ["A one"],
    "the unscoped T01 took A's ticket's place");
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.title), ["B one"],
    "the unscoped T01 took B's ticket's place");
  assert.deepEqual(union.dashboard.tickets.map((ticket) => ticket.title).sort(), ["A one", "B one"],
    "the union shows the unscoped T01 in a scoped ticket's place");
});

// WORKSPACE-FIRST DEFAULT VIEW (o20 / O2900): an unscoped event attributes to
// the workspace of its `by` agent (the Paseo agent registry map); events whose
// `by` cannot be resolved, or that carry no `by`, fall to a global bucket that
// renders only via --all. Attribution applies only when the caller passes the
// map, and never to the no-ws-files class, which keeps the 0.4.0 fold.

test("an unscoped event by another workspace's agent does not enter this workspace's view (o20)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T02", "B agent's ticket", { by: "agent-b" }),
    "",
  ].join("\n");
  const a = foldWith(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.title), ["A ticket"],
    "B agent's unscoped ticket leaked into A's view");
  const b = foldWith(text, "ws-b");
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.title), ["B agent's ticket"],
    "the attributed ticket is missing from its own workspace's view");
});

// GPG's board (dci-harness store): a seat from another workspace closed
// tickets added here, with no ws on the close. The close follows its
// ticket's home, not its writer's workspace.
test("an unscoped update by another workspace's agent follows its ticket's stamped add (o20)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T31", "A ticket", { ws: "ws-a", by: "agent-a" }),
    line({ type: "ticket.update", id: "T31", status: "done", by: "agent-b" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    "",
  ].join("\n");
  const a = foldWith(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => [ticket.id, ticket.status]), [["o31", "closed"]],
    "the unscoped close by B's agent never reached A's ticket");
  assert.deepEqual(foldWith(text, "ws-b").dashboard.tickets, [], "the close must not pull the ticket into B");
});

// The same board's second symptom: the add itself was unscoped (B's agent),
// and this workspace's stamped updates then named an unknown ticket.
test("an unscoped add joins the workspace whose stamped events name its ticket (o20)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T21", "Added by B's agent for A", { by: "agent-b" }),
    line({ type: "ticket.update", id: "T21", status: "skipped", ws: "ws-a", by: "agent-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    "",
  ].join("\n");
  const a = foldWith(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => [ticket.id, ticket.status, ticket.closeReason]), [["o21", "closed", "skipped"]]);
  assert.deepEqual(a.dashboard.issues, [], "no unknown-ticket skips");
  assert.deepEqual(foldWith(text, "ws-b").dashboard.tickets, [], "the add follows its ticket home, not its writer");
});

test("an unscoped event by this workspace's agent stays in its view (o20)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A agent's ticket", { by: "agent-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T02", "B ticket", { ws: "ws-b" }),
    "",
  ].join("\n");
  const a = foldWith(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.title), ["A agent's ticket"]);
});

test("an unscoped event with an unresolvable by renders only in --all (o20)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T02", "Ghost's ticket", { by: "ghost" }),
    add("T03", "No by at all"),
    "",
  ].join("\n");
  const a = foldWith(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.title), ["A ticket"]);
  const all = foldWith(text, UNION_SCOPE);
  assert.deepEqual(all.dashboard.tickets.map((ticket) => ticket.title),
    ["A ticket", "Ghost's ticket", "No by at all"], "the global bucket must still reach --all");
  const globals = all.dashboard.tickets.filter((ticket) => ticket.title !== "A ticket");
  assert.ok(globals.every((ticket) => ticket.ws === ""), "global-bucket tickets carry no workspace");
});

test("scoped events fold exactly as before, agent map or not (o20)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a", status: "done" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T01", "B ticket", { ws: "ws-b" }),
    "",
  ].join("\n");
  assert.deepEqual(foldWith(text, "ws-a").dashboard, fold(text, "ws-a").dashboard);
  assert.deepEqual(foldWith(text, "ws-b").dashboard, fold(text, "ws-b").dashboard);
  assert.deepEqual(foldWith(text, UNION_SCOPE).dashboard, fold(text, UNION_SCOPE).dashboard);
  assert.deepEqual(foldWith(text).dashboard, fold(text).dashboard);
});

test("a file with no ws anywhere keeps the 0.4.0 fold byte for byte, agent map or not (o20 standing rule)", () => {
  const text = [
    line({ type: "run.start", title: "Old run" }),
    add("T90", "Old ticket", { by: "agent-b" }),
    line({ type: "run.start", title: "New run" }),
    add("T01", "New ticket", { by: "ghost" }),
    line({ type: "ticket.update", id: "T01", status: "in_progress", by: "agent-a" }),
    "",
  ].join("\n");
  assert.deepEqual(foldWith(text, "ws-a").dashboard, fold(text, "ws-a").dashboard);
  assert.deepEqual(foldWith(text).dashboard, fold(text).dashboard);
  assert.deepEqual(foldWith(text, UNION_SCOPE).dashboard, fold(text, UNION_SCOPE).dashboard);
});

test("in --all an attributed event folds under its agent's workspace (o20)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T02", "B agent's ticket", { by: "agent-b" }),
    "",
  ].join("\n");
  const all = foldWith(text, UNION_SCOPE);
  const attributed = all.dashboard.tickets.find((ticket) => ticket.title === "B agent's ticket");
  assert.equal(attributed?.ws, "ws-b");
  assert.equal(all.dashboard.tickets.length, 2, "attributed events must not double up in the union");
});

// ── First-class reallocate (o21 / O3000) ───────────────────────────
// `ticket.move` is an append-only correction the fold honours at read time:
// the ticket renders only on the target workspace (and --all), children
// follow the parent, and the source board loses it. No JSONL rewriting.

const move = (id: string, to: string, extra: Record<string, unknown> = {}) =>
  line({ type: "ticket.move", id, to, ws: "ws-a", by: "agent-a", ...extra });

test("a move hides the ticket from the source board and renders it on the target", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    move("T01", "ws-b"),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.title), [], "the source board must lose the moved ticket");
  assert.deepEqual(a.dashboard.issues, [], "the move must parse clean");
  const b = fold(text, "ws-b");
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.title), ["A ticket"], "the target board gains the ticket even with no run of its own");
  // Same result with attribution on: the move is its own correction, not
  // registry attribution.
  assert.deepEqual(foldWith(text, "ws-b").dashboard.tickets.map((ticket) => ticket.title), ["A ticket"]);
});

test("a move renders the ticket only on the target when both workspaces have runs", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    line({ type: "run.start", title: "Workspace B", ws: "ws-b" }),
    add("T02", "B ticket", { ws: "ws-b" }),
    move("T01", "ws-b"),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.id), [], "A's board must be empty after the move");
  const b = fold(text, "ws-b");
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.id).sort(), ["o1", "o2"]);
  const all = fold(text, UNION_SCOPE);
  assert.deepEqual(all.dashboard.tickets.map((ticket) => `${ticket.ws}:${ticket.id}`).sort(), ["ws-b:o1", "ws-b:o2"], "--all keeps the moved ticket, homed on the target");
});

test("a moved ticket's subtree follows the parent", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "Parent", { ws: "ws-a" }),
    add("T01.1", "Child", { ws: "ws-a", under: "T01" }),
    add("T01.1.1", "Grandchild", { ws: "ws-a", under: "T01.1" }),
    move("T01", "ws-b"),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.id), [], "the whole subtree must leave the source");
  const b = fold(text, "ws-b");
  // Nested ids keep the legacy T form (only the exact T01 root migrates to o1).
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.id).sort(), ["T01.1", "T01.1.1", "o1"]);
  const all = fold(text, UNION_SCOPE);
  assert.ok(all.dashboard.tickets.every((ticket) => ticket.ws === "ws-b"), "the subtree renders homed on the target in --all");
});

test("a move correction never frees the spent objective number on the source", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    move("T01", "ws-b"),
    "",
  ].join("\n");
  assert.equal(fold(text, "ws-a").nextIds.ticket, "o2", "the moved ticket's number stays spent");
});

test("the unscoped 0.4.0 fold still folds a file with a move, ignoring the correction", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A ticket", { ws: "ws-a" }),
    move("T01", "ws-b"),
    "",
  ].join("\n");
  const plain = fold(text);
  assert.deepEqual(plain.dashboard.tickets.map((ticket) => ticket.title), ["A ticket"]);
  assert.deepEqual(plain.dashboard.issues, []);
});

test("a no-ws add skips the scoped ticket but a no-ws update still reaches it (D-4, U2)", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "A one", { ws: "ws-a" }),
    line({ type: "run.start", title: "Unresolved run" }),
    add("T01", "Unscoped one"),
    line({ type: "ticket.update", id: "T01", status: "done" }),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  const [ticket] = a.dashboard.tickets;
  assert.equal(ticket.title, "A one", "the unscoped add displaced A's ticket");
  assert.equal(ticket.status, "closed", "the no-ws update no longer reaches A's ticket");
  // The writer's own plain fold is untouched: its run still shows its T01.
  const plain = fold(text);
  assert.equal(plain.dashboard.tickets[0]?.title, "Unscoped one");
});

// ── Stuck roll-up (o18 / O2700, owner ruling) ───────────────────────
// A parent never renders Stuck while any descendant is live: liveness rolls
// up — the parent renders in_progress with its stuck state suppressed — and
// stuck returns only when no descendant is live.

test("a blocked parent renders alive while a child is in_progress (o18)", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Parent"),
    add("T01.1", "Child", { under: "T01" }),
    line({ type: "ticket.update", id: "T01", status: "blocked" }),
    line({ type: "ticket.update", id: "T01.1", status: "in_progress" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  const parent = dashboard.tickets.find((ticket) => ticket.id === "o1");
  assert.equal(parent?.status, "in_progress", "liveness rolls up: the parent renders alive");
  assert.deepEqual(dashboard.stuck, [], "no stuck item for the suppressed parent");
});

test("stuck returns when no descendant is live (o18)", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Parent"),
    add("T01.1", "Child", { under: "T01" }),
    line({ type: "ticket.update", id: "T01", status: "blocked" }),
    line({ type: "ticket.update", id: "T01.1", status: "closed", closeReason: "done" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  assert.equal(dashboard.tickets.find((ticket) => ticket.id === "o1")?.status, "blocked", "quiet subtree: the parent stays stuck");
  assert.deepEqual(dashboard.stuck.map((item) => item.key), ["blocked:o1"]);
});

test("liveness rolls up a deep chain (o18)", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Top"),
    add("T01.1", "Mid", { under: "T01" }),
    add("T01.1.1", "Leaf", { under: "T01.1" }),
    line({ type: "ticket.update", id: "T01", status: "blocked" }),
    line({ type: "ticket.update", id: "T01.1", status: "blocked" }),
    line({ type: "ticket.update", id: "T01.1.1", status: "in_progress" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  assert.deepEqual(dashboard.tickets.filter((ticket) => ticket.status === "blocked").map((ticket) => ticket.id), [], "no stuck renders anywhere up the chain");
  assert.deepEqual(dashboard.tickets.filter((ticket) => ticket.status === "in_progress").map((ticket) => ticket.id).sort(), ["T01.1", "T01.1.1", "o1"]);
});

test("a child's recent activity keeps a blocked parent alive (o18)", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Parent"),
    add("T01.1", "Child", { under: "T01" }),
    line({ type: "ticket.update", id: "T01", status: "blocked", ts: at(5) }),
    line({ type: "activity.add", id: "A1", text: "progress on the child", ticket: "T01.1", ts: at(7) }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  assert.equal(dashboard.tickets.find((ticket) => ticket.id === "o1")?.status, "in_progress", "activity after the parent went blocked keeps it alive");
});

test("a child's activity from before the parent went blocked leaves it stuck (o18)", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Parent"),
    add("T01.1", "Child", { under: "T01" }),
    line({ type: "activity.add", id: "A1", text: "old progress", ticket: "T01.1", ts: at(4) }),
    line({ type: "ticket.update", id: "T01", status: "blocked", ts: at(5) }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  assert.equal(dashboard.tickets.find((ticket) => ticket.id === "o1")?.status, "blocked", "no activity since the block: still stuck");
});

test("a manual stuck flag on a parent with a live child is suppressed (o18)", () => {
  const text = [
    line({ type: "run.start", title: "Run" }),
    add("T01", "Parent"),
    add("T01.1", "Child", { under: "T01" }),
    line({ type: "ticket.update", id: "T01.1", status: "in_progress" }),
    line({ type: "stuck.set", id: "S1", reason: "waiting on word", ticket: "o1" }),
    "",
  ].join("\n");
  const { dashboard } = fold(text);
  assert.deepEqual(dashboard.stuck, [], "the parent renders alive, so its flag stays hidden while the child is live");
});
