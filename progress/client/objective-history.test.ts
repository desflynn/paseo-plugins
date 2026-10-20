// Des, 19 Oct: the board's achieved work sits at the top, before the live
// objectives — the last few closed objectives newest first, each with its
// RESULT line, label-stripped by the same parser the cards use. A board with
// no closed objective shows nothing at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { objectiveHistory, type Ticket } from "../shared/dashboard.ts";
import { clientHarness } from "../../test-support/client-harness.mjs";

const ticket = (over: Partial<Ticket> & { id: string }): Ticket => ({ title: `Objective ${over.id}`, estimateMin: 10, status: "closed", statusSince: "", history: [], ...over });
const closed = (id: string, at: string, result?: string): Ticket => ticket({ id, closeReason: "done", statusSince: at, history: result ? [{ at, status: "closed" as const, note: result }] : [] });

test("closed objectives come newest first by the time they closed", () => {
  const rows = objectiveHistory([closed("o1", "2026-10-19T09:00:00Z"), closed("o3", "2026-10-19T11:00:00Z"), closed("o2", "2026-10-19T10:00:00Z")]);
  assert.deepEqual(rows.map((row) => row.id), ["o3", "o2", "o1"]);
  assert.equal(objectiveHistory([]).length, 0);
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
const load = () => clientHarness(directory, { "react-native": rn, "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } }).load("client/panel.tsx") as { ObjectiveHistory: (props: { colors: unknown; tickets: Ticket[]; expanded: boolean; onToggle(): void }) => unknown; HISTORY_ROWS: number };

// The strings in an element tree, without running the host components.
function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  const props = (node as { props?: { children?: unknown } } | null)?.props;
  return props ? text(props.children) : "";
}

test("the history renders newest first above the live work, capped, and hides when there is none", () => {
  const { ObjectiveHistory, HISTORY_ROWS } = load();
  const colors = {};
  const many = Array.from({ length: 7 }, (_, index) => closed(`o${index + 1}`, `2026-10-19T0${index + 1}:00:00Z`, `RESULT: achieved ${index + 1}`));
  const collapsed = text(ObjectiveHistory({ colors, tickets: many, expanded: false, onToggle: () => {} }));
  assert.equal(HISTORY_ROWS, 5, "five rows while collapsed");
  assert.deepEqual([...collapsed.matchAll(/Objective (o\d+)/g)].map((match) => match[1]), ["o7", "o6", "o5", "o4", "o3"], "newest first, capped");
  assert.ok(collapsed.includes("achieved 7"), "the result text rides the row");
  assert.ok(!collapsed.includes("RESULT:"), "with the label stripped");
  assert.ok(collapsed.includes("Show all 7"), "the expander names the rest");
  const full = text(ObjectiveHistory({ colors, tickets: many, expanded: true, onToggle: () => {} }));
  assert.ok(full.includes("achieved 1"), "expanded shows every closed objective");
  assert.ok(full.includes("Show less"), "and folds back");
  assert.equal(ObjectiveHistory({ colors, tickets: [ticket({ id: "o9", status: "open", statusSince: "" })], expanded: false, onToggle: () => {} }), null, "no closed objective, no section");
});
