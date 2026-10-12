// Scoped reads and appends: nextIds and writer state come from the scoped
// fold, and a scope with no run of its own sees an empty board, never another
// workspace's events.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendProgress, readProgress } from "./progress-file.ts";
import { PROGRESS_FILE_NAME } from "../shared/events.ts";

const T0 = Date.parse("2026-09-27T19:59:00.000Z");
const NOW = new Date(T0 + 2 * 60_000);
const ts = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const line = (minute: number, event: Record<string, unknown>) => JSON.stringify({ v: 1, ts: ts(minute), ...event }) + "\n";

async function worktree(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "progress-scoped-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function write2(directory: string, scope: string, id: string, title: string) {
  return appendProgress(directory, () => NOW, (state) => ({
    event: { type: "ticket.add", id: state.nextIds.ticket, title, estimateMin: 30, ws: scope },
    result: { sawIds: state.nextIds, sawEvents: state.events.filter((event) => event.type === "ticket.add").map((event) => event.id) },
  }), undefined, scope).then((result) => ({ ...result, id }));
}

test("readProgress with a scope folds only that workspace's run", async (t) => {
  const directory = await worktree(t);
  await writeFile(join(directory, PROGRESS_FILE_NAME), [
    line(0, { type: "run.start", title: "Workspace A", ws: "ws-a" }),
    line(1, { type: "ticket.add", id: "T01", title: "A ticket", estimateMin: 60, ws: "ws-a" }),
    line(2, { type: "run.start", title: "Workspace B", ws: "ws-b" }),
    line(3, { type: "ticket.add", id: "T02", title: "B ticket", estimateMin: 60, ws: "ws-b" }),
  ].join(""));
  const a = await readProgress(directory, NOW, "ws-a");
  const b = await readProgress(directory, NOW, "ws-b");
  assert.ok(a.configured && b.configured);
  assert.equal(a.dashboard.run?.title, "Workspace A");
  assert.deepEqual(a.dashboard.tickets.map((ticket) => ticket.id), ["o1"]);
  assert.equal(b.dashboard.run?.title, "Workspace B");
  assert.deepEqual(b.dashboard.tickets.map((ticket) => ticket.id), ["o2"]);
});

test("appendProgress with a scope takes writer state from the scoped fold", async (t) => {
  const directory = await worktree(t);
  await writeFile(join(directory, PROGRESS_FILE_NAME), [
    line(0, { type: "run.start", title: "Workspace A", ws: "ws-a" }),
    line(1, { type: "ticket.add", id: "T01", title: "A ticket", estimateMin: 60, ws: "ws-a" }),
    line(2, { type: "run.start", title: "Workspace B", ws: "ws-b" }),
  ].join(""));
  // Appending as A: A's run already used T01, so the next id is T02.
  const asA = await write2(directory, "ws-a", "T02", "A second");
  assert.deepEqual(asA.sawIds.ticket, "o2");
  assert.deepEqual(asA.sawEvents, ["T01"]);
  // Appending as B: B's run is empty, so B mints its own T01 and sees no events.
  const asB = await write2(directory, "ws-b", "T01", "B first");
  assert.deepEqual(asB.sawIds.ticket, "o1");
  assert.deepEqual(asB.sawEvents, []);
});

// W5 (CHECKPILOT, ruled in): findLastIndex can return -1 and Math.max(-1, 0)
// is 0, which slices from the top of the file. A scope with no run of its own
// must see an EMPTY board and mint no ids from another workspace's run. The
// fix is one line in shared/dashboard.ts (return [] when no start exists),
// which this task does not own; skipped until that task lands.
test("a scope with no run of its own sees an empty board, never another workspace's events (W5)", async (t) => {
  const directory = await worktree(t);
  await writeFile(join(directory, PROGRESS_FILE_NAME), [
    line(0, { type: "run.start", title: "Workspace B", ws: "ws-b" }),
    line(1, { type: "ticket.add", id: "T01", title: "B ticket", estimateMin: 60, ws: "ws-b" }),
    // A legacy writer's event with no ws and no run of its own.
    line(2, { type: "ticket.add", id: "T02", title: "Orphan", estimateMin: 60 }),
  ].join(""));
  const a = await readProgress(directory, NOW, "ws-a");
  assert.ok(a.configured);
  assert.equal(a.dashboard.run, null, "a scope with no run of its own must have no run");
  assert.deepEqual(a.dashboard.tickets, [], "a scope with no run of its own must see no tickets");
  const appended = await write2(directory, "ws-a", "T01", "A first");
  assert.deepEqual(appended.sawIds.ticket, "o1", "a scope with no run mints its own first id");
  assert.deepEqual(appended.sawEvents, []);
});
