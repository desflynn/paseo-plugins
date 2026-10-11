// Workspace scoping: two Paseo workspaces on one checkout each fold to their
// own run, a late unscoped start displaces neither, and a file with no `ws`
// folds exactly as 0.4.0 did. Also: `ref` carried onto Ticket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProgress, reduceProgress } from "../shared/dashboard.ts";

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
