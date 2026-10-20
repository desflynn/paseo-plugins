// A ticket's note may open with GOAL: while it is open, and its close note
// with RESULT: once closed (Des, 19 Oct; convention in dci-harness core.md).
// The card shows the text and not the label; a note with neither label renders
// exactly as it did before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closingNote, labeledLine, type Ticket } from "../shared/dashboard.ts";
import { clientHarness } from "../../test-support/client-harness.mjs";

const ticket = (over: Partial<Ticket> = {}): Ticket => ({ id: "o1", title: "T", estimateMin: 10, status: "open", statusSince: "", history: [], ...over });

test("the label is read from the first line only, and stripped to its text", () => {
  assert.deepEqual(labeledLine("GOAL: ship it\nsecond line"), { label: "GOAL", text: "ship it" });
  assert.deepEqual(labeledLine("result: 364/364, sha 06fc1ce"), { label: "RESULT", text: "364/364, sha 06fc1ce" });
  assert.equal(labeledLine("no label here"), null);
  assert.equal(labeledLine(undefined), null);
  assert.equal(labeledLine("GOAL:   "), null, "an empty goal is nothing to show");
});

test("a closed ticket's line comes from the note on the change that closed it", () => {
  const closed = ticket({
    status: "closed", closeReason: "done", note: "a later note",
    history: [
      { at: "2026-10-19T10:00:00.000Z", note: "GOAL: ship it" },
      { at: "2026-10-19T11:00:00.000Z", status: "closed", note: "RESULT: shipped, 364/364" },
    ],
  });
  assert.equal(closingNote(closed), "RESULT: shipped, 364/364");
  assert.equal(closingNote(ticket({ note: "GOAL: ship it" })), "GOAL: ship it", "no close change: the ticket's own note");
});

// The card itself: an open row shows the GOAL text, a closed row the RESULT
// text, both without the label; an unlabelled note stays as it was.
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
const load = () => clientHarness(directory, { "react-native": rn, "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } }).load("client/panel.tsx") as { LabeledNote: (props: { colors: unknown; ticket: Ticket }) => unknown };

// The strings in an element tree, without running the host components.
function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join(" ");
  const props = (node as { props?: { children?: unknown } } | null)?.props;
  return props ? text(props.children) : "";
}

test("the card shows the goal while open and the result once closed, label stripped", () => {
  const { LabeledNote } = load();
  const colors = {};
  const open = text(LabeledNote({ colors, ticket: ticket({ note: "GOAL: ship it\nmore detail" }) }));
  assert.ok(open.includes("ship it"), "the goal text is on the card");
  assert.ok(!open.includes("GOAL:"), "without the label");
  const closed = text(LabeledNote({ colors, ticket: ticket({ status: "closed", closeReason: "done", id: "o2", history: [{ at: "2026-10-19T11:00:00.000Z", status: "closed", note: "RESULT: shipped, 364/364" }] }) }));
  assert.ok(closed.includes("shipped, 364/364"), "the result text is on the card");
  assert.ok(!closed.includes("RESULT:"), "without the label");
  const plain = text(LabeledNote({ colors, ticket: ticket({ note: "just a note" }) }));
  assert.equal(plain.trim(), "just a note", "an unlabelled note renders as it always did");
  assert.equal(LabeledNote({ colors, ticket: ticket() }), null, "no note, no line");
});
