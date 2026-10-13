// The panel's freeze evidence (o24): a log line for each main-thread stall,
// built from what ran just before it. Pure, so it runs without the app.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lagLine, pushMark, renderSummary, perfFlag, type Mark } from "./perf.ts";

const NOW = Date.parse("2026-10-13T10:00:10.000Z");

test("a stall line gives its length, when it ended and what ran inside and just before it", () => {
  // The stall ran 2.8 s: 10:00:07.200 to 10:00:10.000.
  const marks: Mark[] = [
    { at: NOW - 9_000, what: "ancient poll" },
    { at: NOW - 3_000, what: "dashboard poll start" },
    { at: NOW - 2_800, what: "DashboardView commit 2650ms" },
  ];
  const line = lagLine(2_800, NOW, marks);
  assert.match(line, /^2026-10-13T10:00:10\.000Z LAG 2800ms/);
  assert.match(line, /-200ms dashboard poll start/, "a mark before the stall is shown with a negative offset");
  assert.match(line, /\+0ms DashboardView commit 2650ms/, "a mark inside the stall is shown from its start");
  assert.doesNotMatch(line, /ancient poll/, "marks from long before are left out");
});

test("a stall with nothing recorded around it still says so", () => {
  assert.match(lagLine(900, NOW, []), /LAG 900ms \| no marks/);
});

test("marks keep only the most recent ones", () => {
  const ring: Mark[] = [];
  for (let i = 0; i < 100; i += 1) pushMark(ring, `m${i}`, i);
  assert.equal(ring.length, 40);
  assert.equal(ring[0]!.what, "m60");
  assert.equal(ring[39]!.what, "m99");
});

test("the perf watch is on until the local flag turns it off", () => {
  const reads = new Map<string, string>();
  const store = { getItem: (key: string) => reads.get(key) ?? null };
  assert.equal(perfFlag(undefined), true, "no storage at all: on");
  assert.equal(perfFlag(store), true, "no flag set: on by default");
  reads.set("pp-perf", "0");
  assert.equal(perfFlag(store), false, "pp-perf=0 turns the watch off");
  reads.set("pp-perf", "1");
  assert.equal(perfFlag(store), true, "pp-perf=1 keeps it on");
});

test("the render summary counts renders by cause, most frequent first", () => {
  const counts = new Map([
    ["DashboardView: nothing of mine", 40],
    ["Panel: layout,navigation", 120],
    ["Panel: result", 3],
  ]);
  assert.equal(
    renderSummary(counts, 30, NOW),
    "2026-10-13T10:00:10.000Z RENDERS in 30s | Panel: layout,navigation x120; DashboardView: nothing of mine x40; Panel: result x3",
  );
});

test("a quiet stretch writes no render summary", () => {
  assert.equal(renderSummary(new Map(), 30, NOW), null);
});
