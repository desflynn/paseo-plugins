// The Beads tab view, the bead detail sheet and the ref chip: honest states.
// T13 (O2200) amended the old read-only tab: a bead row now taps open the
// detail sheet — the actions live at the bottom of that sheet, and the tab
// itself still promotes nothing. Runs through the client harness with
// react-native stubbed, so the real component files load and their element
// trees are inspectable.
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
  ActivityIndicator: (props: Record<string, unknown>) => null,
  Platform: { OS: "web" },
} as Record<string, unknown>;

const iconStub = { "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } };

const colors = {
  border: "#border", surface1: "#surface1", surface2: "#surface2",
  foreground: "#foreground", foregroundMuted: "#muted", accent: "#accent",
} as Record<string, string>;

type Node = { type?: unknown; props?: { children?: unknown; style?: unknown; onPress?: unknown; accessibilityLabel?: string; id?: string } };

function load(path: string) {
  return clientHarness(directory, { "react-native": rn, ...iconStub }).load(path) as Record<string, (props: object) => unknown>;
}

// Walks an element tree: every node, every text string, any onPress prop.
function walk(node: unknown, into: { nodes: Node[]; texts: string[]; presses: number }) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) return node.forEach((child) => walk(child, into));
  if (typeof node === "object" && "props" in (node as Node)) {
    const element = node as Node;
    into.nodes.push(element);
    if (element.props?.onPress) into.presses += 1;
    // A function component (BeadRows, BeadsTab) renders one level here, the
    // same convention as panel.test.ts, so its element tree is inspectable.
    if (typeof element.type === "function") walk((element.type as (props: unknown) => unknown)(element.props), into);
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

test("the Beads tab lists priority, id and title per bead; the status mark carries the status word", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const tree = treeOf(BeadsTab({ colors, result: ok }));
  assert.ok(tree.texts.includes("rvr-12"), "bead id missing");
  assert.ok(tree.texts.includes("Swap the pump relay"), "bead title missing");
  assert.ok(tree.texts.includes("home-lab-3") && tree.texts.includes("Log rotation writes twice"), "second bead missing");
  assert.ok(tree.texts.includes("P1"), "priority pill missing");
  assert.ok(!tree.texts.includes("P0") && !tree.texts.includes("Pundefined"), "a pill must render only for a present priority");
  // O2600 (o17): the status lives in the shared icon slot, labelled for reading.
  const marks = tree.nodes.filter((node) => node.props?.accessibilityLabel === "open");
  assert.ok(marks.length >= 1, "the open bead's status is labelled on its mark");
});

// O2600 (o17): one row style — the bead id rides in the row's title line
// exactly like an objective id; the mono family stays on the chips.
test("bead ids ride the shared title line, not a separate mono slot", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const tree = treeOf(BeadsTab({ colors, result: ok }));
  const title = tree.nodes.find((node) => node.type === rn.Text && Array.isArray(node.props?.children) && (node.props?.children as unknown[]).includes("rvr-12"));
  assert.ok(title, "no title line carries the bead id");
  assert.ok((title!.props!.children as unknown[]).includes("Swap the pump relay"), "the id and the title share the line");
});

function treeTexts(node: Node): string[] {
  const into = { nodes: [], texts: [] as string[], presses: 0 };
  walk(node, into);
  return into.texts;
}

// T13 (O2200): amended from "the Beads tab is read-only: no buttons" — the
// detail-view ruling makes each row tap open the sheet. The tab itself still
// promotes nothing: Upgrade lives only at the bottom of the sheet.
test("a bead row taps open the detail sheet; the tab still promotes nothing (T13)", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const tree = treeOf(BeadsTab({ colors, result: ok, onOpenBead: () => {} }));
  assert.ok(tree.presses >= ok.issues.length, "every bead row must be pressable");
  assert.ok(!tree.texts.includes("Upgrade to objective"), "no upgrade button on the tab itself");
});

test("no beads shows the calm 'No beads in this repo' state", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const none = treeOf(BeadsTab({ colors, result: { state: "none" } }));
  assert.deepEqual(
    none.texts.filter((text) => text.trim()),
    ["No beads in this repo"],
    "the none state must show exactly the calm empty text",
  );
  // While the result is still in flight the tab says nothing at all — never a spinner.
  for (const result of [null, undefined]) {
    const tree = treeOf(BeadsTab({ colors, result }));
    assert.deepEqual(tree.texts, [], "an absent result must render nothing");
  }
});

test("an error surfaces as a calm message, never a stack", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const tree = treeOf(BeadsTab({ colors, result: { state: "error", message: "bd exited 2: database is locked" } }));
  assert.ok(tree.texts.some((text) => text.includes("bd exited 2: database is locked")), "the error message must show");
  assert.ok(!tree.texts.some((text) => text.includes("at ")), "no stack lines");
});

// PROOF FIX (revision 7, D-3): the ok state with ZERO issues renders its own
// calm line, distinct from the none text — it never renders nothing.
test("ok with zero issues renders its own calm line, distinct from none (D-3)", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const tree = treeOf(BeadsTab({ colors, result: { state: "ok", issues: [] } }));
  assert.deepEqual(
    tree.texts.filter((text) => text.trim()),
    ["No open beads"],
    "ok with zero issues must render its own calm line, not nothing",
  );
  // The none line stays exactly as it was — the two states read differently.
  const none = treeOf(BeadsTab({ colors, result: { state: "none" } }));
  assert.deepEqual(none.texts.filter((text) => text.trim()), ["No beads in this repo"]);
});

// ── O2600 (o17): the done-sink in every view ─────────────────────
// Closed beads sink behind a collapsed count header that opens: tap to
// expand, tap to fold back. Not a dead count.
const withClosed = {
  state: "ok" as const,
  issues: [
    { id: "rvr-12", title: "Swap the pump relay", status: "open", priority: 1 },
    { id: "pp-8", title: "Shipped relay fix", status: "closed", close_reason: "done" },
    { id: "pp-9", title: "Won't do", status: "closed", close_reason: "skipped" },
  ],
};

test("closed beads sink behind a collapsed count header until it opens (o17)", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const folded = treeOf(BeadsTab({ colors, result: withClosed, onToggleFold: () => {} }));
  assert.ok(folded.texts.includes("1 done, 1 skipped"), "the fold carries the done/skipped counts");
  assert.ok(!folded.texts.includes("Shipped relay fix"), "closed beads stay folded");
  assert.ok(folded.presses >= 1, "the count header opens");
  const opened = treeOf(BeadsTab({ colors, result: withClosed, foldShown: true, onToggleFold: () => {} }));
  assert.ok(opened.texts.includes("Shipped relay fix"), "opened, the closed beads show");
  const shut = treeOf(BeadsTab({ colors, result: withClosed, foldShown: false, onToggleFold: () => {} }));
  assert.ok(!shut.texts.includes("Shipped relay fix"), "folded back, they hide");
});

// O3000 (o30): an epic's children nest inline under it — picking up a sprint
// shows everything in it. Children render indented beneath their epic, in the
// same bucket as the epic; a child whose epic sits in the other bucket stays
// top-level; an orphan (epic absent from the read) stays top-level. No row
// ever renders twice.
const nested = {
  state: "ok",
  issues: [
    { id: "hhc3-epic", title: "Sprint: proposals-v2", status: "in_progress", priority: 1 },
    { id: "hhc3-a", title: "Write the spec", status: "open", parent: "hhc3-epic" },
    { id: "hhc3-b", title: "Ship the cascade", status: "in_progress", parent: "hhc3-epic" },
    { id: "hhc3-c", title: "Closed child", status: "closed", close_reason: "done", parent: "hhc3-epic" },
    { id: "rvr-99", title: "Unrelated bead", status: "open" },
    { id: "orphan-1", title: "Orphan child", status: "open", parent: "hhc3-gone" },
  ],
} as const;

test("an epic's children nest inline under it, indented (o30)", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const tree = treeOf(BeadsTab({ colors, result: nested }));
  assert.ok(tree.texts.includes("Sprint: proposals-v2"), "the epic renders");
  assert.ok(tree.texts.includes("Write the spec") && tree.texts.includes("Ship the cascade"), "the epic's open children render with it");
  // The children sit inside an indented wrapper beneath the epic (18, not a
  // row's own 10 — the row Views carry their own padding too).
  const indent = tree.nodes.filter((node) => node.type === rn.View && (node.props?.style as { paddingLeft?: number } | undefined)?.paddingLeft === 18);
  const wrapped = indent.filter((node) => treeTexts(node).includes("Write the spec"));
  assert.ok(wrapped.length === 1, "open children live under one indented wrapper");
  assert.ok(treeTexts(wrapped[0]).includes("Ship the cascade"), "siblings share the wrapper");
  // Closed child of an open epic sinks — not under the epic, and folded away.
  assert.ok(!tree.texts.includes("Closed child"), "a closed child sits in the sink, not under the open epic");
  assert.ok(tree.texts.includes("Unrelated bead"), "a parentless bead stays top-level");
  assert.ok(tree.texts.includes("Orphan child"), "an orphan child (epic absent) stays top-level, never dropped");
  assert.ok(!indent.some((node) => treeTexts(node).includes("Orphan child")), "the orphan is not indented");
});

// Owner ruling (o6.1, revised 12 Oct): a row title shows at most 120
// characters, ending in an ellipsis, on every tab; the card has it in full.
test("a row's title is cut at 120 characters with an ellipsis", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const long = { state: "ok", issues: [{ id: "rvr-1", title: "A very long bead title ".repeat(9), status: "open" }] } as const;
  const tree = treeOf(BeadsTab({ colors, result: long }));
  const shown = tree.texts.find((text) => text.includes("A very long bead title"))!;
  assert.equal(shown.length, 120, "the row title is not cut at 120 characters");
  assert.ok(shown.endsWith("…"), "the cut title ends in an ellipsis");
});

// Owner ruling (12 Oct): a row's description (the note under the title)
// shows at most 200 characters, ending in an ellipsis; short ones are untouched.
test("a row description is cut at 200 characters with an ellipsis", () => {
  const { clip, NOTE_MAX } = load("client/unified-list.tsx") as unknown as { clip(text: string, max: number): string; NOTE_MAX: number };
  assert.equal(NOTE_MAX, 200);
  const cut = clip("word ".repeat(60), NOTE_MAX);
  assert.equal(cut.length, 200, "the description is not cut at 200 characters");
  assert.ok(cut.endsWith("…"));
  assert.equal(clip("short note", NOTE_MAX), "short note");
});

// Owner ruling: on every tab, a nested row's waiting dot becomes a ">".
// Running and closed marks stay — they carry state the chevron would hide.
test("a nested waiting row marks with > instead of the dot; top-level keeps the dot", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const tree = treeOf(BeadsTab({ colors, result: nested }));
  const chevrons = (node: Node) => treeOf(node).nodes.filter((n) => (n.props as { name?: string } | undefined)?.name === "ChevronRight").length;
  const rowOf = (title: string) => tree.nodes.filter((n) => n.type === rn.View && (n.props?.style as { borderTopWidth?: number } | undefined)?.borderTopWidth === 1 && treeTexts(n).some((t) => t.includes(title)));
  assert.equal(chevrons(rowOf("Write the spec")[0]), 1, "the nested open child carries one >");
  assert.equal(chevrons(rowOf("Ship the cascade")[0]), 0, "a nested running child keeps its spinner");
  assert.equal(chevrons(rowOf("Unrelated bead")[0]), 0, "a top-level open bead keeps its dot");
});

// OWNER SPEC (o30 follow-up): all open beads band by priority — within a
// band the epics come first, each with its children indented under it
// (children ride their epic's band whatever their own pill says), then the
// band's parentless beads. The same law repeats down the priorities.
test("open beads band by priority: epics first with their children, then the rest", () => {
  const { BeadsTab } = load("client/beads.tsx");
  const banded = {
    state: "ok",
    issues: [
      { id: "epic-p1", title: "Sprint one", status: "open", priority: 1 },
      { id: "kid-p2", title: "Kid of sprint one", status: "open", parent: "epic-p1", priority: 2 },
      { id: "lone-p0a", title: "Lone alpha", status: "open", priority: 0 },
      { id: "lone-p0b", title: "Lone beta", status: "open", priority: 0 },
      { id: "lone-p1", title: "Lone gamma", status: "open", priority: 1 },
      { id: "epic-p2", title: "Sprint two", status: "open", priority: 2 },
      { id: "kid-p0", title: "Kid of sprint two", status: "open", parent: "epic-p2", priority: 0 },
    ],
  } as const;
  const tree = treeOf(BeadsTab({ colors, result: banded }));
  const order = tree.nodes
    .map((node) => node.props?.id)
    .filter((id): id is string => typeof id === "string" && id.startsWith("epic-") || typeof id === "string" && id.startsWith("kid-") || typeof id === "string" && id.startsWith("lone-"));
  assert.deepEqual(order, [
    "lone-p0a", "lone-p0b",
    "epic-p1", "kid-p2", "lone-p1",
    "epic-p2", "kid-p0",
  ], "priority bands, epics first, children under their epic");
});

test("an openable fold row points the way the list will move", () => {
  const { DoneSinkRow } = load("client/unified-list.tsx");
  const shut = treeOf(DoneSinkRow({ colors, label: "2 done", done: 2, shown: false, onPress: () => {} }));
  const open = treeOf(DoneSinkRow({ colors, label: "2 done", done: 2, shown: true, onPress: () => {} }));
  assert.equal(shut.presses, 1, "the count header opens");
  assert.equal(open.presses, 1);
  const names = (tree: ReturnType<typeof treeOf>) => tree.nodes.map((node) => (node.props as { name?: string } | undefined)?.name);
  assert.ok(names(shut).includes("ChevronDown"), "folded, the chevron points down");
  assert.ok(names(open).includes("ChevronUp"), "opened, the chevron points up");
});

test("potential rows sit muted; running rows run full-strength (o17)", () => {
  const { UnifiedRow, POTENTIAL_OPACITY } = load("client/unified-list.tsx");
  const styleOf = (tone: string) => {
    const tree = treeOf(UnifiedRow({ colors, icon: null, id: "pp-1", title: "Bead pp-1", tone, priority: 1 }));
    const title = tree.nodes.find((node) => node.type === rn.Text && Array.isArray(node.props?.children));
    return (title?.props?.style as { opacity?: number })?.opacity;
  };
  assert.equal(styleOf("potential"), POTENTIAL_OPACITY, "open-but-not-started sits muted");
  assert.equal(styleOf("running"), 1, "in-progress runs full-strength");
});

// Owner ruling: the detail view shows every title and note in full; the
// ellipsis belongs to the list previews only.
test("a timeline step in the detail view wraps its label and notes instead of clipping them", () => {
  const { TimelineRow } = load("client/ticket-dialog.tsx");
  const long = "A very long stage name that would run past the edge of a narrow dialog and used to be cut off ".repeat(3).trim();
  const step = { label: long, status: "open", at: "2026-10-12T20:00:00.000Z", minutes: 5, notes: [long, "second note " + long] };
  // Shallow: the animated icon swap carries hooks, and only the row's own text matters here.
  const tree = { nodes: [] as Node[], texts: [] as string[] };
  const shallow = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (Array.isArray(node)) return node.forEach(shallow);
    if (typeof node === "object" && "props" in (node as Node)) { tree.nodes.push(node as Node); return shallow((node as Node).props?.children); }
    tree.texts.push(String(node));
  };
  shallow(TimelineRow({ colors, step, last: false, now: Date.parse("2026-10-12T21:00:00.000Z"), live: false }));
  assert.ok(tree.texts.includes(long), "the full label is rendered");
  const clipped = tree.nodes.filter((node) => node.type === rn.Text && (node.props as { numberOfLines?: number } | undefined)?.numberOfLines !== undefined);
  assert.equal(clipped.length, 0, "no text in the detail view is line-clamped");
});

test("the priority pill rides the title line instead of taking its own row", () => {
  const { UnifiedRow } = load("client/unified-list.tsx");
  const tree = treeOf(UnifiedRow({ colors, icon: null, id: "o3", title: "Daemon RPC workspace resolver leg", tone: "potential", priority: 3 }));
  const title = tree.nodes.find((node) => node.type === rn.Text && Array.isArray(node.props?.children));
  const kids = (title?.props?.children ?? []) as Array<{ props?: { children?: unknown } } | string>;
  assert.ok(kids.some((kid) => typeof kid === "object" && kid?.props?.children === "P3"), "the pill sits inside the title text");
  const own = tree.nodes.filter((node) => node.type === rn.View && (node.props?.style as { alignSelf?: string } | undefined)?.alignSelf === "flex-start");
  assert.equal(own.length, 0, "no row of its own for the pill");
  const bare = treeOf(UnifiedRow({ colors, icon: null, id: "o4", title: "No priority", tone: "potential" }));
  assert.ok(!bare.texts.some((text) => /^P\d$/.test(text)), "no pill without a priority");
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

// T13 (O2200): the tab's rows press now — into the sheet. The ref chip stays
// press-free, so that half of the old promise is kept as it was.
test("the ref chip still presses nowhere", () => {
  const { RefChip } = load("client/row.tsx");
  assert.equal(treeOf(RefChip({ colors, ref: "gh:o/r#7" })).presses, 0);
});

// ── T13 (O2200): the detail sheet ────────────────────────────────────

function pressLabels(tree: ReturnType<typeof treeOf>): string[] {
  return tree.nodes
    .filter((node) => typeof node.props?.onPress === "function")
    .map((node) => node.props?.accessibilityLabel as string | undefined)
    .filter((label): label is string => typeof label === "string");
}

test("a tap on a bead row opens the detail sheet (T13)", () => {
  const { BeadRows } = load("client/beads.tsx");
  const opened: string[] = [];
  const tree = treeOf(BeadRows({ colors, issues: [...ok.issues], onOpenBead: (id: string) => opened.push(id) }));
  assert.equal(tree.presses, ok.issues.length, "every bead row must be pressable");
  const first = tree.nodes.find((node) => node.props?.onPress && node.props?.accessibilityLabel === "Open bead rvr-12");
  assert.ok(first, "the row press must be labelled Open bead <id>");
  (first!.props!.onPress as () => void)();
  assert.deepEqual(opened, ["rvr-12"], "tapping a row must open that bead's sheet");
});

test("without a detail handler the rows stay calm and press-free (pre-wiring)", () => {
  const { BeadRows } = load("client/beads.tsx");
  assert.equal(treeOf(BeadRows({ colors, issues: [...ok.issues] })).presses, 0);
});

const openBead = {
  state: "ok" as const,
  bead: {
    id: "rvr-12", title: "Swap the pump relay", status: "open", priority: 1, issue_type: "task",
    description: "Relay clicks twice then dies.", owner: "des@desflynn.com",
    created_at: "2026-10-11T00:00:00Z", created_by: "Des Flynn",
  },
};

function sheet(detail: unknown, beadId: string | null = "rvr-12") {
  const { BeadDialog } = load("client/bead-dialog.tsx");
  return BeadDialog({ colors, beadId, detail, busy: false, onClose: () => {}, onSetStatus: () => {}, onUpgrade: () => {} });
}

test("the sheet shows what the bead is (T13)", () => {
  const tree = treeOf(sheet(openBead));
  for (const text of ["Swap the pump relay", "Relay clicks twice then dies.", "P1", "open", "task", "des@desflynn.com", "Des Flynn"]) {
    assert.ok(tree.texts.includes(text), `${text} missing from the sheet`);
  }
});

test("the sheet's actions sit at the bottom: status changer and Upgrade (T13)", () => {
  const labels = pressLabels(treeOf(sheet(openBead)));
  assert.ok(labels.includes("Upgrade to objective"), "the upgrade button is missing");
  assert.ok(labels.includes("Set status closed") && labels.includes("Set status in_progress"), "the status changer is missing choices");
  assert.ok(!labels.includes("Set status open"), "the current status must not be offered again");
  assert.ok(labels.includes("Close bead detail"), "no way to close the sheet");
});

test("a closed bead offers reopen and shows why it closed (T13)", () => {
  const closed = { state: "ok", bead: { id: "rvr-12", title: "T", status: "closed", priority: 2, close_reason: "done ages ago" } };
  const tree = treeOf(sheet(closed));
  assert.ok(pressLabels(tree).includes("Set status open"), "closed beads must offer reopen");
  assert.ok(tree.texts.includes("done ages ago"), "the close reason must show");
});

test("the sheet stays calm while reading, on error, and with no bead open", () => {
  const reading = treeOf(sheet(null));
  assert.ok(reading.texts.some((text) => text.includes("Reading")), "a calm reading line, never a spinner");
  const errored = treeOf(sheet({ state: "error", message: "bd exited 2: database is locked" }));
  assert.ok(errored.texts.some((text) => text.includes("bd exited 2: database is locked")), "the error message must show");
  const actions = pressLabels(errored).filter((label) => label !== "Close bead detail");
  assert.deepEqual(actions, [], "an error sheet offers no actions");
  assert.equal(sheet(null, null), null, "no bead open, no sheet");
});
