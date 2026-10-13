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
  return clientHarness(directory, { "react-native": rn, "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } }).load(path) as Record<string, (...args: unknown[]) => unknown>;
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
  // O2600: the status lives on the row's shared status mark, not a text column.
  assert.ok(tree.nodes.some((node) => node.props?.accessibilityLabel === "open"), "the open bead's status is labelled on its mark");
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

// O2600 (o17): closed beads sink behind the done-sink, so the badge counts
// the open beads — the work still ahead — not the whole record.
const CLOSED_BEADS = {
  state: "ok",
  issues: [
    { id: "rvr-12", title: "Swap the pump relay", status: "open", priority: 1 },
    { id: "home-lab-3", title: "Log rotation writes twice", status: "in_progress" },
    { id: "pp-8", title: "Shipped relay fix", status: "closed", close_reason: "done" },
    { id: "pp-9", title: "Won't do", status: "closed", close_reason: "skipped" },
  ],
} as const;

test("the Beads badge counts the open beads; closed ones sink behind the fold", () => {
  const { beadsTab } = load("client/panel.tsx");
  const entry = beadsTab(colors, CLOSED_BEADS) as { count?: number; content: unknown };
  assert.equal(entry.count, 2, "closed beads stay out of the badge");
  const tree = treeOf(entry.content);
  assert.ok(tree.texts.includes("1 done, 1 skipped"), "the fold carries the done/skipped counts");
  assert.ok(!tree.texts.includes("Shipped relay fix"), "closed beads stay folded until opened");
  assert.ok(tree.texts.includes("rvr-12"), "the open beads stay in view");
});

// T13 handoff (o13 wiring): with the workspace identity wired, the tab body
// is the live detail sheet, not the pure view — the identity rides on the
// element so the sheet can read and write beads for this workspace. Without
// an identity the pure BeadsView stays, exactly as it rendered before.
test("the Beads tab swaps to the detail sheet once the workspace identity is wired", () => {
  // One harness for both loads: comparing the element type against the
  // BeadsSheet export only means something within one module world.
  const h = clientHarness(directory, { "react-native": rn, "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } });
  const panel = h.load("client/panel.tsx") as Record<string, (...args: unknown[]) => unknown>;
  const { BeadsSheet } = h.load("client/beads-sheet.tsx") as { BeadsSheet: unknown };
  // The body sits inside the shared card frame (O2600), so the sheet is the
  // card's child.
  const bodyOf = (content: { type?: unknown; props?: Record<string, unknown> }) => {
    const children = Array.isArray(content.props?.children) ? (content.props?.children as unknown[]) : [content.props?.children];
    return children.find((child) => typeof child === "object" && child !== null && "type" in child) as { type?: unknown; props?: Record<string, unknown> } | undefined;
  };
  const entry = panel.beadsTab(colors, OK_BEADS, "ws-1", "/repo") as { content: { type?: unknown; props?: Record<string, unknown> } };
  const body = bodyOf(entry.content);
  assert.equal(body?.type, BeadsSheet, "the identity turns the tab body into the live sheet");
  assert.equal(body?.props?.workspaceId, "ws-1", "the sheet gets the workspace id");
  assert.equal(body?.props?.workspaceDirectory, "/repo", "the sheet gets the workspace root");
  const plain = panel.beadsTab(colors, OK_BEADS) as { content: { type?: unknown; props?: Record<string, unknown> } };
  assert.notEqual(bodyOf(plain.content)?.type, BeadsSheet, "no identity, no sheet — the pure view stays");
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
  assert.equal(sections[2].label, "GH", "owner ruling: the short label leaves room for the WS toggle");
  assert.equal(sections[0].count, 2, "the Tickets tab carries the ticket count");
  assert.equal(sections[1].count, 2, "the Beads tab carries the bead count");
  assert.equal(sections[2].count, undefined, "GH Issues is a no-op: no count");
  assert.equal(sections[0].content, marker, "the Tickets body is the ticket panel, unchanged");
});

// The tab badge counts OPEN work only — done work already announces itself
// in the sink label ("N done"), so a total here double-counts it (owner:
// 21 total with 13 done must read 7, never 21).
test("the Objectives tab count is the open count, not the total", () => {
  const { sectionTabs } = load("client/panel.tsx");
  const dash = {
    ...(DASH as object),
    tickets: [
      { id: "T01", status: "closed", closeReason: "done" },
      { id: "T02", status: "closed", closeReason: "skipped" },
      { id: "T03" },
    ],
  } as never;
  const sections = sectionTabs(colors, dash, OK_BEADS, { marker: "x" }) as Array<{ count?: number }>;
  assert.equal(sections[0].count, 1, "the tab count is the open tickets only");
});

test("the section row swaps the body: the Beads body lists the repo's beads", () => {
  const { sections } = sectionRow();
  const tree = treeOf(sections[1].content);
  assert.ok(tree.texts.includes("rvr-12"), "bead id missing from the Beads body");
  assert.ok(tree.texts.includes("Swap the pump relay"), "bead title missing from the Beads body");
  assert.equal(tree.presses.length, 0, "the Beads body stays read-only");
});

test("the GH Issues body is the shared panel with its calm empty state", () => {
  const { sections } = sectionRow();
  const tree = treeOf(sections[2].content);
  assert.equal(tree.presses.length, 0, "no buttons in the GH placeholder");
  assert.ok(!tree.nodes.some((node) => node.type === rn.ActivityIndicator), "never a spinner");
  // The panel's own header hosts the tabs now, so the body carries no
  // "GH Issues" title of its own — just the calm line (owner ruling, tabs
  // in Panel B's header).
  assert.ok(!tree.texts.includes("GH Issues"), "no duplicate title in the body");
  assert.ok(tree.texts.includes("GitHub issues: not yet."), "the calm empty line");
  assert.ok(tree.texts.filter((text) => text.trim()).every((text) => text === "GitHub issues: not yet."), "one quiet line, not a stack");
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

// NESTED CARDS (O1800): linkage renders as chips at the bottom of the card —
// a bead-id chip, and a GitHub chip that opens the issue page on github.com.
// RefChips is hook-free, so it renders directly under the stubbed react-native.
const chipsHarness = clientHarness(directory, { "react-native": rn, "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } });
const ROW_TICKET = {
  id: "o1.1",
  title: "Fix the widget",
  estimateMin: 30,
  status: "open",
  statusSince: "",
  history: [],
  ref: "bead:paseo-plugins-ti5",
  refs: ["gh:desflynn/widgets#42"],
};

test("the linkage renders as chips: a bead-id chip and a GitHub chip that opens the issue page", () => {
  const { RefChips } = chipsHarness.load("client/row.tsx") as Record<string, (props: unknown) => unknown>;
  const tree = treeOf(RefChips({ colors, ticket: ROW_TICKET }));
  assert.ok(tree.texts.includes("paseo-plugins-ti5"), "the bead-id chip shows the slug");
  assert.ok(tree.texts.includes("#42"), "the GitHub chip shows the issue number");
  const gh = tree.nodes.find((node) => node.props?.accessibilityLabel === "GitHub issue 42");
  assert.ok(gh, "the GitHub chip is pressable");
  void (gh!.props!.onPress as () => void)();
  assert.ok(chipsHarness.opened.includes("https://github.com/desflynn/widgets/issues/42"), "the chip opens the issue page on github.com");
});

test("a ticket with no linkage renders no chips", () => {
  const { RefChips } = chipsHarness.load("client/row.tsx") as Record<string, (props: unknown) => unknown>;
  const plain = { ...ROW_TICKET, ref: undefined, refs: undefined };
  assert.equal(treeOf(RefChips({ colors, ticket: plain })).texts.length, 0, "nothing to show");
});

// o24: the Beads read runs every 10 s only while its tab shows. Hidden, it
// keeps the badge numbers fresh about once a minute, and coming back to the
// tab re-reads at once if the list is older than the focused interval.
test("Beads polls every 10 s while showing and once a minute while hidden", () => {
  const { beadsPoll, BEADS_REFRESH_MS, BEADS_BACKGROUND_MS } = load("client/panel.tsx") as unknown as { beadsPoll(active: boolean, ageMs: number): { readNow: boolean; everyMs: number }; BEADS_REFRESH_MS: number; BEADS_BACKGROUND_MS: number };
  assert.equal(BEADS_REFRESH_MS, 10_000);
  assert.equal(BEADS_BACKGROUND_MS, 60_000);
  assert.equal(beadsPoll(true, 0).everyMs, 10_000);
  assert.equal(beadsPoll(false, 0).everyMs, 60_000);
});

test("Beads reads on focus only when the list is out of date", () => {
  const { beadsPoll } = load("client/panel.tsx") as unknown as { beadsPoll(active: boolean, ageMs: number): { readNow: boolean } };
  assert.equal(beadsPoll(true, 4_000).readNow, false, "a 4 s old list stands");
  assert.equal(beadsPoll(true, 10_000).readNow, true, "a 10 s old list is refreshed on focus");
  assert.equal(beadsPoll(true, Number.POSITIVE_INFINITY).readNow, true, "no read yet means read now");
});

// Stacked panels keep their cadences after navigation, so every poll and
// clock pauses while the panel's document is hidden (o24 follow-up).
test("a hidden panel schedules no cadence", () => {
  const { cadence } = load("client/panel.tsx") as unknown as { cadence(baseMs: number, visible: boolean): number };
  assert.equal(cadence(15_000, true), 15_000);
  assert.equal(cadence(10_000, false), 0, "hidden: nothing is scheduled");
});

test("the dashboard poll stops while its panel is hidden", () => {
  const { dashboardQueryOptions, POLL_MS } = load("client/dashboard-query.ts") as unknown as {
    dashboardQueryOptions: (fetchDashboard: unknown, hostId: string, workspaceId: string, directory: string, previous: undefined, scope: "workspace", visible: boolean) => { refetchInterval: number | false };
    POLL_MS: number;
  };
  const never = async () => { throw new Error("a hidden panel does not poll"); };
  assert.equal(dashboardQueryOptions(never, "h", "w", "/repo", undefined, "workspace", false).refetchInterval, false, "hidden: no refetch interval");
  assert.equal(dashboardQueryOptions(never, "h", "w", "/repo", undefined, "workspace", true).refetchInterval, POLL_MS, "visible: the usual cadence");
});
