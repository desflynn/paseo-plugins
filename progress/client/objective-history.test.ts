// Des, 19 Oct (o52): the feed is an objective log — Working and Completed only,
// working rows white and completed rows green — shown on the board page at the
// top, and closed behind a tap in the workspace panel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { objectiveFeed, type Ticket } from "../shared/dashboard.ts";
import { pageFeed } from "../shared/overview.ts";
import { clientHarness } from "../../test-support/client-harness.mjs";

const at = (minute: number) => `2026-10-20T${String(minute).padStart(2, "0")}:00:00.000Z`;
const ticket = (over: Partial<Ticket> & { id: string }): Ticket => ({ title: `Objective ${over.id}`, estimateMin: 10, status: "open", statusSince: at(1), history: [], ...over });
const started = (id: string, minute: number): Ticket => ticket({ id, status: "in_progress", statusSince: at(minute), startedAt: at(minute), history: [{ at: at(1) }, { at: at(minute), status: "in_progress" }] });
const done = (id: string, minute: number, result?: string): Ticket => ticket({ id, status: "closed", closeReason: "done", statusSince: at(minute), history: [{ at: at(1) }, { at: at(minute), status: "closed", note: result }] });

test("the feed is status changes only, in two words, newest first", () => {
  const feed = objectiveFeed([started("o2", 5), done("o1", 3)]);
  assert.deepEqual(feed.map((entry) => [entry.ticket.id, entry.what]), [["o2", "Working"], ["o1", "Completed"]], "adds and updates are noise");
});

const directory = new URL("../", import.meta.url).pathname;
const rn = {
  View: (props: Record<string, unknown>) => null,
  Text: (props: Record<string, unknown>) => null,
  Pressable: (props: Record<string, unknown>) => null,
  ScrollView: (props: Record<string, unknown>) => null,
  ActivityIndicator: (props: Record<string, unknown>) => null,
  Platform: { OS: "web", select: (options: Record<string, unknown>) => options.web },
  Animated: { View: (props: Record<string, unknown>) => null, Value: class { value: number; constructor(value: number) { this.value = value; } interpolate() { return this.value; } }, loop: () => ({ start() {}, stop() {} }), sequence: () => ({}), timing: () => ({}) },
} as Record<string, unknown>;
const load = () => clientHarness(directory, { "react-native": rn, "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } }).load("client/panel.tsx") as { ObjectiveFeed: (props: { colors: unknown; tickets: Ticket[]; open: boolean; onOpen(): void; expanded: boolean; onExpand(): void }) => unknown; FEED_ROWS: number };

function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  const props = (node as { props?: { children?: unknown } } | null)?.props;
  return props ? text(props.children) : "";
}

test("the panel's feed is closed until tapped, then shows working and completed rows", () => {
  const { ObjectiveFeed } = load();
  const board = [done("o1", 2, "RESULT: achieved one"), started("o5", 6)];
  const props = { colors: {}, tickets: board, expanded: false, onOpen: () => {}, onExpand: () => {} };
  const closed = text(ObjectiveFeed({ ...props, open: false }));
  assert.ok(!closed.includes("Objective o1"), "the rows stay behind the tap");
  const open = text(ObjectiveFeed({ ...props, open: true }));
  assert.ok(open.indexOf("Now") < open.indexOf("Recently changed"), "now first");
  assert.ok(open.indexOf("Recently changed") < open.indexOf("Finished"), "then changes, then finished");
  assert.ok(open.includes("Working"), "a working row");
  assert.ok(open.includes("Completed"), "a completed row");
  assert.ok(open.includes("achieved one") && !open.includes("RESULT:"), "the result text, label stripped");
  assert.equal(ObjectiveFeed({ colors: {}, tickets: [ticket({ id: "o9" })], open: true, onOpen: () => {}, expanded: false, onExpand: () => {} }), null, "no history, nothing live: no feed");
});

test("the page feed merges every board's feed, newest first", () => {
  const summary = (feed: NonNullable<import("../shared/overview.ts").BoardSummary["feed"]>) => ({ title: "B", open: 0, inProgress: 0, done: 0, statuses: [], percent: 0, doneMin: 0, totalMin: 0, inProgressMin: 0, priorities: { p0: 0, p1: 0, p2: 0, lower: 0 }, autoCount: 0, now: null, ready: [], feed });
  const group = (id: string, title: string, feed: NonNullable<import("../shared/overview.ts").BoardSummary["feed"]>) => ({ projectId: id, projectName: id, workspaces: [{ workspace: { id, projectId: id, projectName: id, name: id, directory: `/r/${id}` }, board: summary(feed), agents: [] }], totals: { boards: 1, fullAutos: 0, active: 0, stuck: 0, agents: 0 } });
  const rows = pageFeed([
    group("a", "A", { live: [{ id: "o1", title: "Live A", at: at(9), priority: 1 }], changes: [{ id: "o1", title: "Live A", what: "Working", at: at(9), priority: 1 }], finished: [] }),
    group("b", "B", { live: [], changes: [{ id: "o2", title: "Done B", what: "Completed", at: at(10), priority: 2 }], finished: [{ id: "o2", title: "Done B", at: at(10), priority: 2, result: "shipped" }] }),
  ]);
  assert.deepEqual(rows.live.map((row) => row.title), ["Live A"]);
  assert.deepEqual(rows.changes.map((row) => row.title), ["Done B", "Live A"], "newest first across boards");
  assert.deepEqual(rows.finished.map((row) => [row.title, row.result]), [["Done B", "shipped"]]);
});
