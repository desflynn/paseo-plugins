// Workspace scoping: two Paseo workspaces on one checkout each fold to their
// own run, a late unscoped start displaces neither, and a file with no `ws`
// folds exactly as 0.4.0 did. Also: `ref` carried onto Ticket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProgress, reduceProgress, UNION_SCOPE } from "../shared/dashboard.ts";

const T0 = Date.parse("2026-09-27T19:59:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const NOW = new Date(T0 + 2 * 60_000);

const line = (event: Record<string, unknown>) => JSON.stringify({ v: 1, ts: at(0), ...event });

function fold(text: string, scope?: string) {
  return reduceProgress(parseProgress(text), NOW, scope);
}

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
  assert.equal(a.nextIds.ticket, "T02");
  // B's run has no tickets of its own, so it mints T01 even though A used it.
  assert.equal(b.nextIds.ticket, "T01");
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
  assert.ok(a.dashboard.tickets.some((ticket) => ticket.id === "T01"), "workspace A's board was emptied");
  assert.ok(b.dashboard.run, "workspace B lost its run slot");
});

test("legacy events with no ws stay visible inside a scoped run", () => {
  const text = [
    line({ type: "run.start", title: "Workspace A", ws: "ws-a" }),
    add("T01", "Legacy ticket"),
    "",
  ].join("\n");
  const a = fold(text, "ws-a");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.id), ["T01"]);
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
  assert.deepEqual(all.dashboard.tickets.map((ticket) => ticket.id), ["T01"]);
  assert.equal(all.nextIds.ticket, "T02");
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
  assert.deepEqual(all.dashboard.tickets.map((ticket) => ticket.id), ["T02"]);
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
  const fromBead = dashboard.tickets.find((ticket) => ticket.id === "T01");
  assert.equal(fromBead?.ref, "gh:o/r#7");
  const noRef = dashboard.tickets.find((ticket) => ticket.id === "T02");
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
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.id).sort(), ["T01", "T01"], "both T01s show");
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.title).sort(), ["A ticket", "B ticket"]);
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
  assert.deepEqual(union.dashboard.tickets.map((ticket) => ticket.id), ["T01"]);
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
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.id), ["T01"]);
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.id), ["T02"]);
  assert.equal(union.dashboard.run?.title, "Workspace B", "stray displaced the union header");
});
