// The panel's scope control and Beads tab wiring: the new pure pieces, run
// through the client harness with react-native stubbed, so their element
// trees are inspectable. The hookful glue (useState in WorkspaceProgress,
// the tabs array in DashboardView) is typed by typecheck and proven on
// screenshots by the smoke worker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientHarness } from "../../test-support/client-harness.mjs";

const directory = new URL("../", import.meta.url).pathname;

// react-native stubs: identity components so tree nodes can be told apart by
// their `type`, and onPress hooks stay visible for the read-only assertions.
const rn = {
  View: (props: Record<string, unknown>) => null,
  Text: (props: Record<string, unknown>) => null,
  Pressable: (props: Record<string, unknown>) => null,
  ScrollView: (props: Record<string, unknown>) => null,
  ActivityIndicator: (props: Record<string, unknown>) => null,
  Platform: { OS: "web", select: (options: Record<string, unknown>) => options.web },
  Animated: {
    View: (props: Record<string, unknown>) => null,
    Value: class {
      value: number;
      constructor(value: number) { this.value = value; }
      interpolate() { return this.value; }
    },
    loop: () => ({ start() {}, stop() {} }),
    sequence: () => ({}),
    timing: () => ({}),
  },
} as Record<string, unknown>;

const colors = {
  border: "#border", surface0: "#surface0", surface1: "#surface1", surface2: "#surface2",
  foreground: "#foreground", foregroundMuted: "#muted", accent: "#accent",
} as Record<string, string>;

type Node = { type?: unknown; props?: { children?: unknown; style?: unknown; onPress?: unknown; accessibilityState?: { selected?: boolean }; accessibilityLabel?: string } };

function load(path: string) {
  return clientHarness(directory, { "react-native": rn }).load(path) as Record<string, (...args: unknown[]) => unknown>;
}

// Walks an element tree: every node, every text string, any onPress prop.
function walk(node: unknown, into: { nodes: Node[]; texts: string[]; presses: string[] }) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) return node.forEach((child) => walk(child, into));
  if (typeof node === "object" && "props" in (node as Node)) {
    const element = node as Node;
    into.nodes.push(element);
    if (typeof element.props?.onPress === "function") into.presses.push(element.props.accessibilityLabel ?? "");
    // A function component (BeadsView) is pure here, so render one level to see its tree.
    if (typeof element.type === "function") walk((element.type as (props: unknown) => unknown)(element.props), into);
    walk(element.props?.children, into);
    return;
  }
  into.texts.push(String(node));
}

function treeOf(view: unknown) {
  const into = { nodes: [] as Node[], texts: [] as string[], presses: [] as string[] };
  walk(view, into);
  return into;
}

test("the header control defaults to This workspace", () => {
  const { DEFAULT_SCOPE } = load("client/panel.tsx");
  assert.equal(DEFAULT_SCOPE, "workspace");
});

test("the scope control shows both choices and marks the selected one", () => {
  const { ScopeControl } = load("client/panel.tsx");
  const tree = treeOf(ScopeControl({ colors, scope: "workspace", onChange: () => {} }));
  assert.ok(tree.texts.includes("This workspace"), "the This workspace label is missing");
  assert.ok(tree.texts.includes("All"), "the All label is missing");
  const selected = tree.nodes.filter((node) => node.props?.accessibilityState?.selected === true);
  assert.equal(selected.length, 1, "exactly one choice is selected");
  assert.equal(selected[0].props?.accessibilityLabel, "This workspace");
});

test("choosing a scope reports it", () => {
  const { ScopeControl } = load("client/panel.tsx");
  const seen: Array<"workspace" | "all"> = [];
  const tree = treeOf(ScopeControl({ colors, scope: "workspace", onChange: (scope: "workspace" | "all") => seen.push(scope) }));
  assert.equal(tree.presses.length, 2, "both choices press");
  const all = tree.nodes.find((node) => node.props?.accessibilityLabel === "All");
  (all!.props!.onPress as () => void)();
  assert.deepEqual(seen, ["all"]);
  const workspace = tree.nodes.find((node) => node.props?.accessibilityLabel === "This workspace");
  (workspace!.props!.onPress as () => void)();
  assert.deepEqual(seen, ["all", "workspace"]);
});

const OK_BEADS = {
  state: "ok",
  issues: [
    { id: "rvr-12", title: "Swap the pump relay", status: "open", priority: 1 },
    { id: "home-lab-3", title: "Log rotation writes twice", status: "in_progress" },
  ],
} as const;

test("the Beads tab entry lists the repo's beads", () => {
  const { beadsTab } = load("client/panel.tsx");
  const entry = beadsTab(colors, OK_BEADS) as { id: string; label: string; count?: number; content: unknown };
  assert.equal(entry.id, "beads");
  assert.equal(entry.label, "Beads");
  assert.equal(entry.count, 2);
  const tree = treeOf(entry.content);
  assert.ok(tree.texts.includes("rvr-12"), "bead id missing from the tab content");
  assert.ok(tree.texts.includes("Swap the pump relay"), "bead title missing from the tab content");
  assert.ok(tree.texts.includes("open"), "bead status missing from the tab content");
});

test("the Beads tab entry stays calm when there is nothing to list", () => {
  const { beadsTab } = load("client/panel.tsx");
  const none = beadsTab(colors, { state: "none" }) as { count?: number; content: unknown };
  assert.equal(none.count, undefined, "no count badge without beads");
  assert.ok(treeOf(none.content).texts.includes("No beads in this repo"));
  const error = beadsTab(colors, { state: "error", message: "bd is missing" }) as { content: unknown };
  assert.ok(treeOf(error.content).texts.includes("bd is missing"));
  const pending = beadsTab(colors, null) as { count?: number; content: unknown };
  assert.equal(pending.count, undefined);
  assert.equal(pending.content, null, "an absent result says nothing at all");
});

// OWNER RETAB (revision 4): the top-level section row is Tickets, Beads,
// GH Issues, where the tickets section sits; the body below the row swaps.
const DASH = {
  run: { itemLabel: "Ticket" },
  tickets: [{ id: "T01" }, { id: "T02" }],
  activity: [], questions: { open: [], answered: [] }, deliverables: [], stuck: [],
} as never;

function sectionRow(beads: unknown = OK_BEADS) {
  const { sectionTabs } = load("client/panel.tsx");
  const marker = { marker: "tickets-body" };
  return { sections: sectionTabs(colors, DASH, beads, marker) as Array<{ id: string; label: string; count?: number; content: unknown }>, marker };
}

test("the top section row is Tickets, Beads, GH Issues, in that order", () => {
  const { sections, marker } = sectionRow();
  assert.equal(sections.length, 3, "three tabs");
  assert.equal(sections[0].id, "tickets");
  assert.equal(sections[1].id, "beads");
  assert.equal(sections[2].id, "gh");
  assert.equal(sections[0].label, "Tickets");
  assert.equal(sections[1].label, "Beads");
  assert.equal(sections[2].label, "GH Issues");
  assert.equal(sections[0].count, 2, "the Tickets tab carries the ticket count");
  assert.equal(sections[1].count, 2, "the Beads tab carries the bead count");
  assert.equal(sections[2].count, undefined, "GH Issues is a no-op: no count");
  assert.equal(sections[0].content, marker, "the Tickets body is the ticket panel, unchanged");
});

test("the section row swaps the body: the Beads body lists the repo's beads", () => {
  const { sections } = sectionRow();
  const tree = treeOf(sections[1].content);
  assert.ok(tree.texts.includes("rvr-12"), "bead id missing from the Beads body");
  assert.ok(tree.texts.includes("Swap the pump relay"), "bead title missing from the Beads body");
  assert.equal(tree.presses.length, 0, "the Beads body stays read-only");
});

test("the GH Issues body is a calm no-op placeholder", () => {
  const { sections } = sectionRow();
  const tree = treeOf(sections[2].content);
  assert.equal(tree.presses.length, 0, "no buttons in the GH placeholder");
  assert.ok(!tree.nodes.some((node) => node.type === rn.ActivityIndicator), "never a spinner");
  const lines = tree.texts.filter((text) => text.trim());
  assert.equal(lines.length, 1, "one quiet line, not a stack");
  assert.match(lines[0], /github issues: not yet\./i);
});

// OWNER TOGGLE (revision 4): the two scope chips become ONE card-like WS/GIT
// toggle — fixed size either way, tap to flip, default WS; GIT-only in a
// worktree, where the workspace fold no-ops.
test("the scope toggle is one card: WS by default, tapping flips to GIT and back", () => {
  const { ScopeToggle } = load("client/panel.tsx");
  const seen: Array<"workspace" | "all"> = [];
  const ws = treeOf(ScopeToggle({ colors, scope: "workspace", onChange: (scope: "workspace" | "all") => seen.push(scope) }));
  assert.deepEqual(ws.texts, ["WS"], "the workspace side reads WS");
  const wsButton = ws.nodes.find((node) => node.props?.onPress);
  (wsButton!.props!.onPress as () => void)();
  const git = treeOf(ScopeToggle({ colors, scope: "all", onChange: (scope: "workspace" | "all") => seen.push(scope) }));
  assert.deepEqual(git.texts, ["GIT"], "the all side reads GIT");
  const gitButton = git.nodes.find((node) => node.props?.onPress);
  (gitButton!.props!.onPress as () => void)();
  assert.deepEqual(seen, ["all", "workspace"], "tapping toggles to the other view");
});

test("the toggle is a fixed size either way", () => {
  const { ScopeToggle } = load("client/panel.tsx");
  const widthOf = (scope: "workspace" | "all") => {
    const tree = treeOf(ScopeToggle({ colors, scope, onChange: () => {} }));
    const button = tree.nodes.find((node) => node.props?.onPress);
    return (button?.props?.style as (state: unknown) => { minWidth?: number })({ pressed: false })?.minWidth;
  };
  assert.equal(widthOf("workspace"), widthOf("all"), "WS and GIT render at the same size");
  assert.ok(widthOf("workspace"), "the fixed width is set");
});

test("inside a worktree the toggle shows GIT only and stays still", () => {
  const { ScopeToggle } = load("client/panel.tsx");
  const tree = treeOf(ScopeToggle({ colors, scope: "workspace", onChange: () => {}, gitOnly: true }));
  assert.deepEqual(tree.texts, ["GIT"], "GIT alone, no WS");
  assert.equal(tree.presses.length, 0, "nothing to toggle to in a worktree");
});
