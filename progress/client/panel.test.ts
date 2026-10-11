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
