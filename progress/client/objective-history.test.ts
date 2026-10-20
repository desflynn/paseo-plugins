// Des, 19 Oct (o239): the feed at the top of the panel — now, the recent
// objective and status changes with their times, the recent completions with
// their RESULT line, and the full history behind one More info. A label rides a
// row and never decides whether the row appears.
import assert from "node:assert/strict";
import { test } from "node:test";
import { objectiveFeed, type Ticket } from "../shared/dashboard.ts";
import { clientHarness } from "../../test-support/client-harness.mjs";

const at = (minute: number) => `2026-10-20T${String(minute).padStart(2, "0")}:00:00.000Z`;
const ticket = (over: Partial<Ticket> & { id: string }): Ticket => ({ title: `Objective ${over.id}`, estimateMin: 10, status: "open", statusSince: at(1), history: [], ...over });
const started = (id: string, minute: number): Ticket => ticket({ id, status: "in_progress", statusSince: at(minute), startedAt: at(minute), history: [{ at: at(1) }, { at: at(minute), status: "in_progress" }] });
const done = (id: string, minute: number, result?: string): Ticket => ticket({ id, status: "closed", closeReason: "done", statusSince: at(minute), history: [{ at: at(1) }, { at: at(minute), status: "closed", note: result }] });
const skipped = (id: string, minute: number): Ticket => ticket({ id, status: "closed", closeReason: "skipped", statusSince: at(minute), history: [{ at: at(1) }, { at: at(minute), status: "closed" }] });

test("the feed is the objective and status changes, newest first, each with what happened", () => {
  const feed = objectiveFeed([started("o2", 5), done("o1", 3)]);
  assert.deepEqual(feed.slice(0, 3).map((entry) => [entry.ticket.id, entry.what]), [["o2", "Started"], ["o1", "Completed"], ["o2", "Added"]]);
  assert.equal(objectiveFeed([skipped("o9", 4)])[0].what, "Skipped", "a skipped close says so");
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
const load = () => clientHarness(directory, { "react-native": rn, "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } }).load("client/panel.tsx") as { ObjectiveFeed: (props: { colors: unknown; tickets: Ticket[]; expanded: boolean; onToggle(): void }) => unknown; FEED_ROWS: number };

// The strings in an element tree, without running the host components.
function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  const props = (node as { props?: { children?: unknown } } | null)?.props;
  return props ? text(props.children) : "";
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

test("the feed shows now, then what changed, then what finished, and More info holds the rest", () => {
  const { ObjectiveFeed, FEED_ROWS } = load();
  const colors = {};
  const board = [done("o1", 2, "RESULT: achieved one"), done("o2", 3), done("o3", 4), done("o4", 5), started("o5", 6)];
  const collapsed = text(ObjectiveFeed({ colors, tickets: board, expanded: false, onToggle: () => {} }));
  assert.equal(FEED_ROWS, 6, "the window is the last six changes");
  assert.ok(collapsed.indexOf("Now") < collapsed.indexOf("Recently changed"), "now first");
  assert.ok(collapsed.indexOf("Recently changed") < collapsed.indexOf("Finished"), "then the changes, then the finished");
  assert.ok(collapsed.includes("Objective o5"), "the live objective is in Now");
  assert.ok(collapsed.includes("achieved one"), "a completion carries its RESULT text");
  assert.ok(!collapsed.includes("RESULT:"), "with the label stripped");
  assert.equal(count(collapsed, "Added"), 1, "six changes fit above the fold");
  assert.ok(collapsed.includes("More info (10)"), "the toggle names the whole history");
  const expanded = text(ObjectiveFeed({ colors, tickets: board, expanded: true, onToggle: () => {} }));
  assert.equal(count(expanded, "Added"), 5, "expanded shows every change ever");
  assert.ok(expanded.includes("Show less"));
});

test("a board with nothing live and nothing finished renders no feed", () => {
  const { ObjectiveFeed } = load();
  assert.equal(ObjectiveFeed({ colors: {}, tickets: [ticket({ id: "o9" })], expanded: false, onToggle: () => {} }), null, "no history, no feed");
  assert.ok(text(ObjectiveFeed({ colors: {}, tickets: [done("o1", 2)], expanded: false, onToggle: () => {} })).includes("Nothing running — finished, gone idle"), "finished and quiet says so");
});
