// The Beads tab view and the ref chip: read-only, honest states, no buttons.
// Runs through the client harness with react-native stubbed, so the real
// component files load and their element trees are inspectable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientHarness } from "../../test-support/client-harness.mjs";

const directory = new URL("../", import.meta.url).pathname;

// react-native stubs: identity functions so tree nodes can be told apart by
// their `type`, and onPress hooks are visible for the read-only assertions.
const rn = {
  View: (props: Record<string, unknown>) => null,
  Text: (props: Record<string, unknown>) => null,
  Pressable: (props: Record<string, unknown>) => null,
} as Record<string, (props: Record<string, unknown>) => null>;

const colors = {
  border: "#border", surface1: "#surface1", surface2: "#surface2",
  foreground: "#foreground", foregroundMuted: "#muted", accent: "#accent",
} as Record<string, string>;

type Node = { type?: unknown; props?: { children?: unknown; style?: unknown; onPress?: unknown } };

function load(path: string) {
  return clientHarness(directory, { "react-native": rn }).load(path) as Record<string, (props: object) => unknown>;
}

// Walks an element tree: every node, every text string, any onPress prop.
function walk(node: unknown, into: { nodes: Node[]; texts: string[]; presses: number }) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) return node.forEach((child) => walk(child, into));
  if (typeof node === "object" && "props" in (node as Node)) {
    const element = node as Node;
    into.nodes.push(element);
    if (element.props?.onPress) into.presses += 1;
    walk(element.props?.children, into);
    return;
  }
  into.texts.push(String(node));
}

function treeOf(view: unknown) {
  const into = { nodes: [] as Node[], texts: [] as string[], presses: 0 };
  walk(view, into);
  return into;
}

const ok = {
  state: "ok",
  issues: [
    { id: "rvr-12", title: "Swap the pump relay", status: "open", priority: 1 },
    { id: "home-lab-3", title: "Log rotation writes twice", status: "in_progress" },
  ],
} as const;

test("the Beads tab lists priority, id, title and status per bead", () => {
  const { BeadsView } = load("client/beads.tsx");
  const tree = treeOf(BeadsView({ colors, result: ok }));
  assert.ok(tree.texts.includes("rvr-12"), "bead id missing");
  assert.ok(tree.texts.includes("Swap the pump relay"), "bead title missing");
  assert.ok(tree.texts.includes("open"), "bead status missing");
  assert.ok(tree.texts.includes("home-lab-3") && tree.texts.includes("Log rotation writes twice"), "second bead missing");
  assert.ok(tree.texts.includes("P1"), "priority pill missing");
  assert.ok(!tree.texts.includes("P0") && !tree.texts.includes("Pundefined"), "a pill must render only for a present priority");
});

test("bead ids render as muted mono text", () => {
  const { BeadsView } = load("client/beads.tsx");
  const tree = treeOf(BeadsView({ colors, result: ok }));
  const idNode = tree.nodes.find((node) => node.type === rn.Text && node.props?.children === "rvr-12");
  assert.ok(idNode, "no Text node renders the bead id");
  const style = idNode?.props?.style as { fontFamily?: string; color?: string } | undefined;
  assert.equal(style?.fontFamily, "monospace");
  assert.equal(style?.color, colors.foregroundMuted);
});

function treeTexts(node: Node): string[] {
  const into = { nodes: [], texts: [] as string[], presses: 0 };
  walk(node, into);
  return into.texts;
}

test("the Beads tab is read-only: no buttons, no promotion", () => {
  const { BeadsView } = load("client/beads.tsx");
  const tree = treeOf(BeadsView({ colors, result: ok }));
  assert.equal(tree.presses, 0, "the Beads tab must not contain pressables");
});

test("no beads shows the calm 'No beads in this repo' state", () => {
  const { BeadsView } = load("client/beads.tsx");
  const none = treeOf(BeadsView({ colors, result: { state: "none" } }));
  assert.deepEqual(
    none.texts.filter((text) => text.trim()),
    ["No beads in this repo"],
    "the none state must show exactly the calm empty text",
  );
  // While the result is still in flight the tab says nothing at all — never a spinner.
  for (const result of [null, undefined]) {
    const tree = treeOf(BeadsView({ colors, result }));
    assert.deepEqual(tree.texts, [], "an absent result must render nothing");
  }
});

test("an error surfaces as a calm message, never a stack", () => {
  const { BeadsView } = load("client/beads.tsx");
  const tree = treeOf(BeadsView({ colors, result: { state: "error", message: "bd exited 2: database is locked" } }));
  assert.ok(tree.texts.some((text) => text.includes("bd exited 2: database is locked")), "the error message must show");
  assert.ok(!tree.texts.some((text) => text.includes("at ")), "no stack lines");
});

// PROOF FIX (revision 7, D-3): the ok state with ZERO issues renders its own
// calm line, distinct from the none text — it never renders nothing.
test("ok with zero issues renders its own calm line, distinct from none (D-3)", () => {
  const { BeadsView } = load("client/beads.tsx");
  const tree = treeOf(BeadsView({ colors, result: { state: "ok", issues: [] } }));
  assert.deepEqual(
    tree.texts.filter((text) => text.trim()),
    ["No open beads"],
    "ok with zero issues must render its own calm line, not nothing",
  );
  // The none line stays exactly as it was — the two states read differently.
  const none = treeOf(BeadsView({ colors, result: { state: "none" } }));
  assert.deepEqual(none.texts.filter((text) => text.trim()), ["No beads in this repo"]);
});

test("the ref chip shows the ref as muted mono and appears only when there is one", () => {
  const { RefChip } = load("client/row.tsx");
  const withRef = treeOf(RefChip({ colors, ref: "bead:rvr-1" }));
  assert.deepEqual(withRef.texts, ["bead:rvr-1"]);
  const textNode = withRef.nodes.find((node) => node.type === rn.Text);
  const style = textNode?.props?.style as { fontFamily?: string; color?: string } | undefined;
  assert.equal(style?.fontFamily, "monospace");
  assert.equal(style?.color, colors.foregroundMuted);
  const without = RefChip({ colors, ref: undefined });
  assert.equal(without, null, "no ref, no chip");
});

test("neither the Beads tab nor the ref chip presses anywhere", () => {
  const { BeadsView } = load("client/beads.tsx");
  const { RefChip } = load("client/row.tsx");
  for (const view of [BeadsView({ colors, result: ok }), RefChip({ colors, ref: "gh:o/r#7" })]) {
    assert.equal(treeOf(view).presses, 0);
  }
});
