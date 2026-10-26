// o36: the Progress page. Pure pieces only: one board folded to a summary, and
// every workspace's summary and live agents grouped by project. Boards are
// folded from JSONL text like scoping.test.ts; the page glue is typecheck and
// screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardStatuses, parseProgress, reduceProgress } from "../shared/dashboard.ts";
import { machineTint, shortLabel } from "../shared/machine.ts";
import { BOARD_MODES, MODE_LABEL } from "../shared/modes.ts";
import {
  archiveConfirm, archivedFor, barSegments, cardAgents, plainName, buildSections, cardCount, chatsSpan, gridLayout, MODE_BUTTONS, MODE_TINT, modeConfirm, packRepos, repoSpan, spanWidth, headerCounts, optionHint, priorityChips, repoSummary, resultLine, splitGroup, statusDots, readyRows,
  groupOverview, summariseBoard, summaryOf, type AgentRef, type BoardSummary, type WorkspaceRef,
} from "../shared/overview.ts";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const NOW = new Date(T0 + 5 * 60_000);
const line = (event: Record<string, unknown>, minute = 0) => JSON.stringify({ v: 1, ts: at(minute), ...event });
const add = (id: string, extra: Record<string, unknown> = {}) => line({ type: "ticket.add", id, title: id, estimateMin: 30, ...extra });

function board(...events: string[]) {
  return reduceProgress(parseProgress(events.length ? `${events.join("\n")}\n` : ""), NOW).dashboard;
}

test("a board folds to its title, counts, indicator and conn; no run means no board", () => {
  assert.equal(summariseBoard(board()), null);
  const dashboard = board(
    line({ type: "run.start", title: "PP HG's board" }),
    add("o1"),
    add("o2"),
    add("o3"),
    line({ type: "ticket.update", id: "o2", status: "in_progress" }, 1),
    line({ type: "ticket.update", id: "o3", status: "closed", closeReason: "done" }, 2),
    line({ type: "conn.set", budget: 2, mode: "live", nextNudgeAt: at(55), clear: true }, 3),
  );
  const summary = summariseBoard(dashboard);
  assert.ok(summary);
  assert.equal(summary.title, "PP HG's board");
  assert.deepEqual({ open: summary.open, inProgress: summary.inProgress, done: summary.done }, { open: 1, inProgress: 1, done: 1 });
  assert.equal(summary.conn?.budget, 2);
  assert.equal(summary.conn?.clear, true);
  assert.deepEqual(summary.statuses.map((s) => s.kind), ["active"]);
  const idle = summariseBoard(board(line({ type: "run.start", title: "Quiet" }), add("o1")));
  assert.deepEqual(idle?.statuses, [{ kind: "idle" }]);
  assert.equal("conn" in (idle ?? {}), false, "conn is left out when off");
  assert.equal("hold" in (idle ?? {}), false, "hold is left out when off");
  const held = summariseBoard(board(line({ type: "run.start", title: "Spec" }), line({ type: "hold.set", kind: "speccing", note: "with Des" }, 1)));
  assert.deepEqual(held?.hold, { on: true, kind: "speccing", note: "with Des", since: at(1) });
});

test("a board's summary is built once per snapshot, not once per poll", () => {
  // The Progress page asks for every board every 3 s; an unchanged board must
  // not pay the sort and the passes again.
  const dashboard = board(line({ type: "run.start", title: "PP HG's board" }), add("o1"));
  const first = summaryOf(dashboard);
  assert.ok(first);
  assert.strictEqual(summaryOf(dashboard), first, "the same snapshot hands back the same summary");
  assert.notStrictEqual(summaryOf(board(line({ type: "run.start", title: "PP HG's board" }), add("o1"))), first, "a new snapshot is summarised again");
});

const ws = (id: string, projectId: string, projectName: string, name: string, labels: string[] = []): WorkspaceRef => ({ id, projectId, projectName, name, directory: `/repo/${id}`, ...(labels.length ? { labels } : {}) });
const agent = (id: string, workspaceId: string, status: AgentRef["status"], title: string | null = id): AgentRef => ({ id, workspaceId, status, title, parentAgentId: null });
const summary = (over: Partial<BoardSummary> = {}): BoardSummary => ({
  title: "Board", open: 1, inProgress: 0, done: 0, statuses: [{ kind: "idle" }],
  percent: 0, doneMin: 0, totalMin: 0, inProgressMin: 0, priorities: { p0: 0, p1: 0, p2: 0, lower: 0 }, autoCount: 0, now: null, ready: [],
  ...over,
});

test("workspaces group under their project, keeping only those with a board or a live agent", () => {
  const groups = groupOverview(
    [ws("w1", "p-b", "Beta", "main"), ws("w2", "p-a", "Alpha", "feature"), ws("w3", "p-a", "Alpha", "empty"), ws("w4", "p-a", "Alpha", "agents only")],
    { w1: summary(), w2: summary({ title: "Alpha board" }), w3: null, w4: null },
    [agent("a1", "w4", "running"), agent("a2", "w3", "closed")],
  );
  assert.deepEqual(groups.map((g) => g.projectName), ["Alpha", "Beta"], "projects by name");
  assert.deepEqual(groups[0].workspaces.map((w) => w.workspace.name).sort(), ["agents only", "feature"], "the empty workspace and its closed agent drop out");
  assert.equal(groups[0].workspaces.find((w) => w.workspace.id === "w4")?.board, null);
});

test("agents nest under their workspace, running first, closed ones left out", () => {
  const [group] = groupOverview(
    [ws("w1", "p", "Proj", "main")],
    { w1: summary() },
    [agent("idle", "w1", "idle"), agent("done", "w1", "closed"), agent("busy", "w1", "running"), agent("other", "w9", "running")],
  );
  assert.deepEqual(group.workspaces[0].agents.map((a) => a.id), ["busy", "idle"]);
});

// Des, 16-17 Oct: boards in a repo go the BRO-labelled workspaces first (Zoe, Joey), then Head Guy,
// then Ninja, then the rest alphabetically. State no longer reorders them, and a name alone is not BRO.
test("boards in a repo go BRO, Head Guy, Ninja, then alphabetical, whatever their state", () => {
  const names = ["Quantix Data Review", "🥷🏼HHC3 Ninja 🟧", "Archive run", "🧔‍♂️HHC3 Head Guy ♾️🏁 🟧", "Joey", "head-guys", "Zoe", "central ninja", "Zoey"];
  const bro = new Set(["Joey", "Zoe"]);
  const [group] = groupOverview(names.map((name, i) => ws(`w${i}`, "p", "Proj", name, bro.has(name) ? ["MINE", "BRO"] : [])), Object.fromEntries(names.map((_, i) => [`w${i}`, summary()])), []);
  assert.deepEqual(group.workspaces.map((w) => w.workspace.name), [
    "Joey", "Zoe",
    "head-guys", "🧔‍♂️HHC3 Head Guy ♾️🏁 🟧",
    "central ninja", "🥷🏼HHC3 Ninja 🟧",
    "Archive run", "Quantix Data Review", "Zoey",
  ]);
});

test("a project totals its workspaces, and a full auto or stuck board no longer jumps the order", () => {
  const groups = groupOverview(
    [ws("w1", "p", "Proj", "plain"), ws("w2", "p", "Proj", "auto"), ws("w3", "p", "Proj", "stuck")],
    {
      w1: summary(),
      w2: summary({ conn: { on: true, budget: 2, mode: "live", nextNudgeAt: at(55), since: at(0) }, statuses: [{ kind: "active", count: 1 }] }),
      w3: summary({ statuses: [{ kind: "stuck", count: 2 }] }),
    },
    [],
  );
  const [group] = groups;
  assert.deepEqual(group.workspaces.map((w) => w.workspace.name), ["auto", "plain", "stuck"]);
  assert.deepEqual(group.totals, { boards: 3, fullAutos: 1, active: 1, stuck: 2, agents: 0 });
});

// ── o38: the dashboard overhaul. Everything the cards show is folded here. ──

const prio = (id: string, priority: number | null, extra: Record<string, unknown> = {}) => add(id, { ...(priority === null ? {} : { priority }), ...extra });

test("a board summary carries work time, priority counts, the auto count, the now line and the open list", () => {
  const dashboard = board(
    line({ type: "run.start", title: "Work" }),
    prio("o1", 0, { estimateMin: 60 }),
    prio("o2", 1, { estimateMin: 120 }),
    prio("o3", 3, { estimateMin: 30 }),
    prio("o4", null, { estimateMin: 30 }),
    prio("o5", 2, { estimateMin: 60 }),
    line({ type: "ticket.update", id: "o2", status: "in_progress", stage: "Build" }, 1),
    line({ type: "ticket.update", id: "o5", status: "closed", closeReason: "done" }, 2),
  );
  const s = summariseBoard(dashboard)!;
  assert.deepEqual({ done: s.doneMin, total: s.totalMin, ip: s.inProgressMin, pct: s.percent }, { done: 60, total: 300, ip: 120, pct: 20 }, "minutes come from the estimates, same as the board's own percent");
  assert.deepEqual(s.priorities, { p0: 1, p1: 1, p2: 0, lower: 2 }, "open and in progress by priority, the finished P2 left out, P3 and none are lower");
  assert.equal(s.autoCount, 2, "open or in progress P0 to P2: what full auto would pull");
  assert.equal(s.now?.id, "o2");
  assert.equal(s.now?.title, "o2");
  assert.equal(s.now?.stage, "Build");
  assert.equal(s.now?.more, 0);
  assert.deepEqual(s.ready.map((r) => [r.id, r.priority, r.auto, r.working]), [["o2", 1, true, true], ["o1", 0, true, false], ["o3", 3, false, false], ["o4", 5, false, false]], "unfinished only, in progress first as in the panel, then best first; no priority reads P5");
});

test("open rows carry their depth, so sub-objectives indent like the panel", () => {
  const s = summariseBoard(board(
    line({ type: "run.start", title: "Work" }),
    add("o1", { priority: 1 }),
    add("o1.1", { priority: 1, under: "o1" }),
    add("o1.1.1", { priority: 1, under: "o1.1" }),
    add("o2", { priority: 1 }),
  ))!;
  assert.deepEqual(s.ready.map((r) => [r.id, r.depth]), [["o1", 0], ["o1.1", 1], ["o1.1.1", 2], ["o2", 0]]);
});

test("more than one thing in progress: the now line names the first and counts the rest", () => {
  const s = summariseBoard(board(
    line({ type: "run.start", title: "Work" }), prio("o1", 2), prio("o2", 0),
    line({ type: "ticket.update", id: "o1", status: "in_progress" }, 1),
    line({ type: "ticket.update", id: "o2", status: "in_progress" }, 2),
  ))!;
  assert.equal(s.now?.id, "o2", "the most urgent first");
  assert.equal(s.now?.more, 1);
  assert.equal(summariseBoard(board(line({ type: "run.start", title: "Idle" }), add("o1")))!.now, null);
});

test("the bar splits by estimated minutes, and stale or stuck work tints the unfinished part", () => {
  const base = summary({ doneMin: 60, inProgressMin: 30, totalMin: 120 });
  assert.deepEqual(barSegments(base), [
    { kind: "done", flex: 60 }, { kind: "progress", flex: 30 }, { kind: "open", flex: 30 },
  ]);
  assert.deepEqual(barSegments(summary({ doneMin: 0, inProgressMin: 30, totalMin: 60, statuses: [{ kind: "stale", count: 1 }] })),
    [{ kind: "progress", flex: 30, tint: "warning" }, { kind: "open", flex: 30 }]);
  assert.deepEqual(barSegments(summary({ doneMin: 0, inProgressMin: 0, totalMin: 60, statuses: [{ kind: "stuck", count: 1 }] })), [{ kind: "open", flex: 60, tint: "danger" }]);
  assert.deepEqual(barSegments(summary()), [], "no estimates, no bar");
});

test("priority chips list P0 to P2 that have work, and say how much sits lower", () => {
  assert.deepEqual(priorityChips(summary({ priorities: { p0: 1, p1: 0, p2: 3, lower: 4 } })), { chips: ["P0 1", "P2 3"], lower: "+4 lower" });
  assert.deepEqual(priorityChips(summary({ priorities: { p0: 0, p1: 0, p2: 0, lower: 4 } })), { chips: [], lower: null });
  assert.deepEqual(priorityChips(summary({ priorities: { p0: 2, p1: 0, p2: 0, lower: 0 } })), { chips: ["P0 2"], lower: null });
});

test("an in-progress objective always shows in the open list, even below P2", () => {
  const rows = readyRows(summary({ ready: [
    { id: "o1", title: "A", priority: 0, auto: true, depth: 0, working: false },
    { id: "o2", title: "B", priority: 4, auto: false, depth: 0, working: true },
    { id: "o3", title: "C", priority: 3, auto: false, depth: 0, working: false },
  ] }));
  assert.deepEqual(rows.items.map((item) => item.id), ["o1", "o2"]);
  assert.equal(rows.more, "+1 more open");
});

test("+n more open expands to the parked rows and folds back", () => {
  const ready = [
    { id: "o1", title: "A", priority: 0, auto: true, depth: 0, working: false },
    { id: "o2", title: "B", priority: 3, auto: false, depth: 0, working: false },
    { id: "o3", title: "C", priority: 5, auto: false, depth: 0, working: false },
  ];
  const folded = readyRows(summary({ ready }));
  assert.deepEqual([folded.items.map((item) => item.id), folded.more], [["o1"], "+2 more open"]);
  const open = readyRows(summary({ ready }), true);
  assert.deepEqual([open.items.map((item) => item.id), open.more], [["o1", "o2", "o3"], "Show fewer"]);
  assert.equal(readyRows(summary({ ready: ready.slice(0, 1) }), true).more, "", "nothing parked, nothing to toggle");
});

test("the open list shows the queued P0-P2 and folds P3, P4 and unset into +n more open", () => {
  const queued = Array.from({ length: 10 }, (_, i) => ({ id: `o${i + 1}`, title: `T${i}`, priority: i % 3, auto: true, depth: 0, working: false }));
  const parked = [3, 4, 5].map((priority, i) => ({ id: `o${20 + i}`, title: `P${i}`, priority, auto: false, depth: 0, working: false }));
  const rows = readyRows(summary({ ready: [...queued, ...parked] }));
  assert.equal(rows.items.length, 10, "every queued row shows, no cap");
  assert.ok(rows.items.every((item) => item.auto));
  assert.equal(rows.total, 13);
  assert.equal(rows.more, "+3 more open");
  assert.equal(readyRows(summary({ ready: queued.slice(0, 2) })).more, "");
});

test("a name drops the full auto marks the card header already shows, and keeps the rest", () => {
  assert.equal(plainName("🧔‍♂️DCI Head Guy ♾️🏁 🟧"), "🧔‍♂️DCI Head Guy 🟧");
  assert.equal(plainName("PP Head Guy ♾️ 🟧"), "PP Head Guy 🟧");
  assert.equal(plainName("HHC3 Head Guy ♾ 🏁"), "HHC3 Head Guy");
  assert.equal(plainName("HHC3 Ninja 🟧"), "HHC3 Ninja 🟧");
  assert.equal(plainName("Nightly Automations"), "Nightly Automations");
});

test("a card lists its agents only when the owner has company", () => {
  const owner = agent("a1", "w1", "idle", "HHC3 Ninja");
  assert.deepEqual(cardAgents([owner], owner), [], "a lone owner is already in the card header");
  const helper = agent("a2", "w1", "running", "Helper");
  assert.deepEqual(cardAgents([helper, owner], owner).map((a) => a.id), ["a1", "a2"], "owner first, then the rest");
  assert.deepEqual(cardAgents([helper], null).map((a) => a.id), ["a2"], "no owner, nothing to repeat");
  assert.deepEqual(cardAgents([], null), []);
});

test("status dots read stuck, stale, active, idle", () => {
  assert.deepEqual(statusDots([{ kind: "active", count: 2 }, { kind: "stuck", count: 1 }]), [{ kind: "stuck", label: "Stuck 1" }, { kind: "active", label: "Active 2" }]);
  assert.deepEqual(statusDots([{ kind: "idle" }]), [{ kind: "idle", label: "Idle" }]);
});

const one = (id: string, project: string, board: BoardSummary | null, agents: AgentRef[] = []) =>
  groupOverview([ws(id, project, project, id)], { [id]: board }, agents)[0];
const live = (status: BoardSummary["statuses"], extra: Partial<BoardSummary> = {}) => summary({ statuses: status, autoCount: 1, ...extra });
const HOLD = { on: true as const, kind: "closed" as const, since: at(0) };

test("a repo sorts into Active, Idle or Quiet", () => {
  const sections = (...groups: ReturnType<typeof one>[]) => buildSections(groups).map((s) => [s.id, s.groups.map((g) => g.projectName)]);
  assert.deepEqual(sections(
    one("w1", "A-active", live([{ kind: "active", count: 1 }])),
    one("w2", "B-idle", live([{ kind: "idle" }])),
    one("w3", "C-stuck", live([{ kind: "stuck", count: 1 }])),
    one("w4", "D-stale", live([{ kind: "stale", count: 1 }])),
    one("w5", "E-held", live([{ kind: "idle" }], { hold: HOLD })),
    one("w6", "F-nothing", summary({ autoCount: 0 })),
    one("w7", "G-chats", null, [agent("a1", "w7", "idle")]),
  ), [["active", ["A-active"]], ["idle", ["B-idle"]], ["quiet", ["C-stuck", "D-stale", "E-held", "F-nothing", "G-chats"]]]);
  assert.deepEqual(buildSections([]), [], "empty sections are left out");
});

test("repos with BRO-labelled boards sit in Top while all those boards are idle; otherwise they lead Active", () => {
  const zoeIdle = (id: string, project: string, status: BoardSummary["statuses"]) => groupOverview([ws(id, project, project, "Zoe", ["BRO"])], { [id]: live(status) }, [])[0];
  const names = (...groups: ReturnType<typeof one>[]) => buildSections(groups).map((s) => [s.id, s.groups.map((g) => g.projectName)]);
  assert.deepEqual(names(
    one("w1", "A-work", live([{ kind: "active", count: 1 }])),
    zoeIdle("w2", "Z-zoe", [{ kind: "idle" }]),
  ), [["top", ["Z-zoe"]], ["active", ["A-work"]]]);
  assert.deepEqual(names(
    one("w1", "A-work", live([{ kind: "active", count: 1 }])),
    zoeIdle("w2", "Z-zoe", [{ kind: "active", count: 1 }]),
  ), [["active", ["Z-zoe", "A-work"]]], "not idle: into Active, at the top");
  const [both] = groupOverview([ws("w1", "p", "Pair", "Zoe", ["BRO"]), ws("w2", "p", "Pair", "Joey", ["bro"])], { w1: live([{ kind: "idle" }]), w2: live([{ kind: "stuck", count: 1 }]) }, []);
  assert.equal(buildSections([both])[0].id, "active", "both must be idle for Top, and the label ignores case");
  assert.equal(buildSections([one("w3", "plain", live([{ kind: "idle" }]))])[0].id, "idle", "a repo without a BRO board is unaffected");
  const [named] = groupOverview([ws("w4", "q", "Named", "Zoe")], { w4: live([{ kind: "idle" }]) }, []);
  assert.equal(buildSections([named])[0].id, "idle", "a board called Zoe without the BRO label is not Top");
});

test("Top folds itself when the Tops and every agent in their repos are idle", () => {
  const top = (statuses: AgentRef["status"][]) => {
    const groups = groupOverview(
      [ws("w1", "central", "central", "Zoe", ["BRO"]), ws("w2", "home-lab", "home-lab", "Joey", ["BRO"])],
      { w1: live([{ kind: "idle" }]), w2: live([{ kind: "idle" }]) },
      statuses.map((status, index) => agent(`a${index}`, index === 0 ? "w1" : "w2", status)),
    );
    return buildSections(groups)[0];
  };
  const idle = top(["idle", "idle"]);
  assert.equal(idle.foldedByDefault, true, "everyone idle: the section folds itself");
  assert.equal(idle.sub, "Zoe and Joey are idle.");
  const busy = top(["idle", "running"]);
  assert.equal(busy.foldedByDefault, false, "a running agent keeps it open");
  assert.equal(busy.sub, "BRO boards, while all of them are idle", "the usual line stays");
});

test("across repos, a section runs BRO, Head Guy, Ninja, anyone else, then repos with only unboarded agents", () => {
  const repo = (id: string, project: string, board: string | null, status: BoardSummary["statuses"]) =>
    groupOverview([ws(id, project, project, board ?? "chat", board === "Joey" ? ["BRO"] : [])], { [id]: board ? live(status) : null }, board ? [] : [agent(`a-${id}`, id, "idle")])[0];
  const names = (...groups: ReturnType<typeof one>[]) => buildSections(groups).map((s) => [s.id, s.groups.map((g) => g.projectName)]);
  const work = [{ kind: "active" as const, count: 1 }];
  assert.deepEqual(names(
    repo("w1", "A-other", "Builder", work),
    repo("w2", "B-ninja", "HL Ninja", work),
    repo("w3", "C-head", "🧑 PP Head Guy", work),
    repo("w4", "D-zoe", "Joey", work),
    repo("w5", "E-head", "HHC3 Head Guy", work),
  ), [["active", ["D-zoe", "C-head", "E-head", "B-ninja", "A-other"]]], "ties keep repo name order");
  assert.deepEqual(names(
    repo("w1", "A-chats", null, []),
    repo("w2", "B-board", "Builder", [{ kind: "stale", count: 1 }]),
    repo("w3", "C-head", "Head Guy", [{ kind: "stale", count: 1 }]),
  ), [["quiet", ["C-head", "B-board", "A-chats"]]], "repos with only unboarded agents come last");
});

test("a repo with one active board is Active even when another board is stuck", () => {
  const [group] = groupOverview(
    [ws("w1", "p", "Proj", "a"), ws("w2", "p", "Proj", "b")],
    { w1: live([{ kind: "active", count: 1 }]), w2: live([{ kind: "stuck", count: 1 }]) }, []);
  assert.equal(buildSections([group])[0].id, "active");
});

test("the header counts boards, repos, active, stuck, stale and chats without a board", () => {
  const groups = groupOverview(
    [ws("w1", "p1", "One", "a"), ws("w2", "p1", "One", "b"), ws("w3", "p2", "Two", "c"), ws("w4", "p2", "Two", "chat")],
    { w1: live([{ kind: "active", count: 1 }, { kind: "stuck", count: 2 }]), w2: live([{ kind: "stale", count: 1 }]), w3: summary(), w4: null },
    [agent("a1", "w4", "idle")],
  );
  assert.deepEqual(headerCounts(groups), { boards: 3, repos: 2, active: 1, stuck: 1, stale: 1, chats: 1 }, "a board counts once per state it is in");
});

test("a repo splits into boards and agents without a board, and sums up as boards and agents", () => {
  const [group] = groupOverview(
    [ws("w1", "p", "Proj", "board"), ws("w2", "p", "Proj", "chat")],
    { w1: summary(), w2: null },
    [agent("a1", "w1", "running"), agent("a2", "w2", "idle"), agent("a3", "w2", "idle")],
  );
  const { boards, chats } = splitGroup(group);
  assert.deepEqual([boards.map((e) => e.workspace.id), chats.map((e) => e.workspace.id)], [["w1"], ["w2"]]);
  assert.equal(repoSummary(group), "1 board · 3 agents");
  assert.equal(repoSummary(one("w9", "q", summary())), "1 board · 0 agents");
});

test("Nightly Automations is not an agent chat: it leaves the card and the header count, and an emptied card goes", () => {
  const groups = groupOverview(
    [ws("w1", "p", "Proj", "Nightly Automations"), ws("w2", "p", "Proj", "chat")],
    { w1: null, w2: null },
    [agent("a1", "w1", "idle"), agent("a2", "w2", "idle")],
  );
  assert.deepEqual(splitGroup(groups[0]).chats.map((e) => e.workspace.name), ["chat"]);
  assert.equal(headerCounts(groups).chats, 1);
  const [only] = groupOverview([ws("w1", "p", "Proj", "nightly automations")], { w1: null }, [agent("a1", "w1", "idle")]);
  assert.deepEqual(splitGroup(only).chats, []);
  assert.equal(cardCount(only), 0);
});

test("a repo's archived agents are the ones working inside its folder, newest first", () => {
  const [group] = groupOverview([{ ...ws("w1", "p", "Proj", "Board"), projectPath: "/repo/proj" }], { w1: null }, [agent("live", "w1", "idle")]);
  const old =(id: string, cwd: string, archivedAt: string, title: string | null = id) => ({ id, title, cwd, archivedAt });
  const found = archivedFor(group, [
    old("a1", "/repo/proj", "2026-10-14T10:00:00.000Z"),
    old("a2", "/repo/proj/sub/dir", "2026-10-16T10:00:00.000Z"),
    old("a3", "/repo/proj-other", "2026-10-16T11:00:00.000Z"),
    old("a4", "/elsewhere", "2026-10-16T12:00:00.000Z"),
  ]);
  assert.deepEqual(found.map((a) => a.id), ["a2", "a1"], "prefix match on whole folder names only");
  assert.deepEqual(archivedFor(group, []), []);
});

test("the hint for each state says who starts it, in plain words", () => {
  assert.match(optionHint("fullauto", "PP Head Guy", null), /Asks PP Head Guy to start full auto/);
  assert.match(optionHint("clear", "PP Head Guy", null), /Asks PP Head Guy to clear the board/);
  assert.match(optionHint("hold", "PP Head Guy", null), /set at once/i);
  assert.match(optionHint("spec", "PP Head Guy", null), /set at once/i);
  assert.match(optionHint("fullauto", null, null), /No live agent/);
  const conn = { on: true as const, budget: 2, mode: "live" as const, nextNudgeAt: at(55), since: at(0) };
  assert.match(optionHint("manual", "PP Head Guy", conn), /Asks PP Head Guy to turn full auto off/);
  assert.doesNotMatch(optionHint("manual", "PP Head Guy", null), /Asks/);
});

test("the result of a change says who was told, or what failed and that the board change stands", () => {
  assert.deepEqual(resultLine({ mode: "fullauto", pinged: true }, "PP Head Guy"), { tone: "ok", text: "Told PP Head Guy." });
  assert.deepEqual(resultLine({ mode: "hold", pinged: false }, "PP Head Guy"), { tone: "ok", text: "Board set to Hold." });
  assert.deepEqual(resultLine({ mode: "hold", pinged: false, error: "No agent to tell." }, null), { tone: "warning", text: "No agent to tell. The board change still stands." });
});

test("the card grid: 3 columns from 900 wide, 2 from 620, else 1, and the cards never add up wider than the grid", () => {
  const gap = 12;
  const wide = gridLayout(1262, gap);
  assert.equal(wide.columns, 3);
  assert.ok(wide.columns * wide.cardWidth + (wide.columns - 1) * gap <= 1262);
  assert.equal(gridLayout(700, gap).columns, 2);
  assert.equal(gridLayout(500, gap).columns, 1);
  assert.deepEqual([gridLayout(899, gap).columns, gridLayout(900, gap).columns, gridLayout(619, gap).columns, gridLayout(620, gap).columns], [2, 3, 1, 2]);
  for (let width = 300; width <= 2400; width++) {
    const { columns, cardWidth } = gridLayout(width, gap);
    assert.ok(Number.isInteger(cardWidth), `whole pixels at ${width}`);
    assert.ok(columns * cardWidth + (columns - 1) * gap < width, `${width}: ${columns} x ${cardWidth} must leave slack`);
  }
});

test("the agents-without-a-board card goes full width when it would sit alone at the start of a row", () => {
  assert.equal(chatsSpan(3, 2), "card", "2 boards, 3 columns: it shares row 1");
  assert.equal(chatsSpan(3, 3), "full", "3 boards fill row 1, so it would start row 2 alone");
  assert.equal(chatsSpan(3, 4), "card", "4 boards leave room beside the 4th");
  assert.equal(chatsSpan(3, 5), "card");
  assert.equal(chatsSpan(3, 6), "full");
  assert.equal(chatsSpan(2, 2), "full");
  assert.equal(chatsSpan(2, 3), "card");
  assert.equal(chatsSpan(3, 0), "full", "no boards: it is alone in its row");
  for (const boards of [0, 1, 2, 5]) assert.equal(chatsSpan(1, boards), "full", "one column is always full width");
});

test("each of the five states has its own Lucide icon, and the word stays MODE_LABEL's", () => {
  assert.deepEqual(MODE_BUTTONS.map((button) => button.mode), [...BOARD_MODES], "same states, same order");
  assert.deepEqual(MODE_BUTTONS.map((button) => button.icon), ["CornerDownLeft", "Pause", "NotebookPen", "ArrowDownToDot", "Infinity"]);
  assert.equal(new Set(MODE_BUTTONS.map((button) => button.icon)).size, BOARD_MODES.length, "icons are distinct");
  for (const button of MODE_BUTTONS) assert.equal(button.label, MODE_LABEL[button.mode], "the word is the tooltip and the aria-label");
});

// o38.1 and o38.2 (Des, 16 Oct): archive buttons with a confirm step that says
// plainly what goes. Archiving a workspace takes everything it owns with it.
test("the archive confirm names what goes, says when work is running, and keeps a board's file", () => {
  const board = archiveConfirm({ kind: "workspace", name: "HHC3 HG", agents: 3, running: 0, board: "HHC3 HG's board" });
  assert.equal(board.title, "Archive board and workspace?");
  assert.equal(board.action, "Archive board and workspace");
  assert.match(board.body, /^"HHC3 HG" and its board leave the dashboard\./);
  assert.match(board.body, /3 agents go with it\./);
  assert.match(board.body, /The board's file stays in the repo\./);
  assert.doesNotMatch(board.body, /running/);

  const busy = archiveConfirm({ kind: "workspace", name: "HHC3 HG", agents: 3, running: 2, board: "HHC3 HG's board" });
  assert.match(busy.body, /2 are running and will be interrupted\./);
  assert.match(archiveConfirm({ kind: "workspace", name: "main", agents: 1, running: 1, board: null }).body, /1 agent goes with it\. 1 is running and will be interrupted\./);

  const chat = archiveConfirm({ kind: "workspace", name: "main", agents: 0, running: 0, board: null });
  assert.equal(chat.title, "Archive workspace?");
  assert.equal(chat.action, "Archive workspace");
  assert.match(chat.body, /^"main" leaves the dashboard\./);
  assert.doesNotMatch(chat.body, /\bboard\b/i, "a chat has no board to mention");
  assert.doesNotMatch(chat.body, /go with it/, "no agents, nothing to list");

  const idle = archiveConfirm({ kind: "agent", name: "Hello.", running: false });
  assert.deepEqual([idle.title, idle.action], ["Archive agent?", "Archive agent"]);
  assert.match(idle.body, /^"Hello\." is archived and leaves the dashboard\.$/);
  assert.match(archiveConfirm({ kind: "agent", name: "Hello.", running: true }).body, /It is running, so this interrupts it\.$/);
});

// Des, 16 Oct: "All close/idle commands must be modaled." Moving a board to an
// idle state (Manual, Hold, Spec) asks first; the two states that start work do not.
test("the idle states ask before they are set, and the states that start work do not", () => {
  const board = { name: "HHC3 HG's board", owner: "HHC3 Head Guy", fullAuto: false, held: false };
  assert.equal(modeConfirm("fullauto", board), null);
  assert.equal(modeConfirm("clear", board), null);

  const hold = modeConfirm("hold", board)!;
  assert.deepEqual([hold.title, hold.action], ["Put the board on hold?", "Put on hold"]);
  assert.equal(hold.body, `"HHC3 HG's board" is paused: items can still be added, but nothing new starts.`);
  assert.match(modeConfirm("hold", { ...board, fullAuto: true })!.body, /Full auto stays on underneath and carries on when you lift this\.$/);

  const spec = modeConfirm("spec", board)!;
  assert.deepEqual([spec.title, spec.action], ["Switch the board to Spec?", "Switch to Spec"]);
  assert.match(spec.body, /^"HHC3 HG's board" pauses new work while objectives are written up\./);
  assert.match(modeConfirm("spec", { ...board, fullAuto: true })!.body, /Full auto stays on underneath/);

  const manual = modeConfirm("manual", board)!;
  assert.deepEqual([manual.title, manual.action], ["Switch the board to Manual?", "Switch to Manual"]);
  assert.equal(manual.body, `"HHC3 HG's board" goes back to you picking the work. Nothing starts on its own.`);
  assert.match(modeConfirm("manual", { ...board, held: true })!.body, /The hold is lifted\./);
  assert.match(modeConfirm("manual", { ...board, fullAuto: true })!.body, /Asks HHC3 Head Guy to turn full auto off\.$/);
  assert.match(modeConfirm("manual", { ...board, fullAuto: true, owner: null })!.body, /No live agent on this board to turn full auto off, so it stays on\.$/);
});

// Des, 16 Oct: repos with few cards share a row. Three columns: a repo takes as
// many columns as it has cards (three or more is a whole row), repos fill rows in
// order, so rows are 1-1-1, 1-2 or 2-1 and never 1-3. In two columns a row is 1-1
// or a 2. A repo sits alone only when the next one does not fit beside it.
test("a repo takes as many columns as it has cards, up to a whole row", () => {
  assert.deepEqual([[1, 3], [2, 3], [3, 3], [7, 3], [0, 3], [2, 2], [5, 2], [4, 1]].map(([cards, columns]) => repoSpan(cards, columns)), [1, 2, 3, 3, 1, 2, 2, 1]);
});

test("repos pack in order into rows of three columns: 1-1-1, 1-2, 2-1, never 1-3", () => {
  const pack = (cards: number[], columns: number) => packRepos(cards.map((count) => repoSpan(count, columns)), columns);
  assert.deepEqual(pack([1, 1, 1, 1], 3), [[0, 1, 2], [3]]);
  assert.deepEqual(pack([1, 2], 3), [[0, 1]]);
  assert.deepEqual(pack([2, 1], 3), [[0, 1]]);
  assert.deepEqual(pack([1, 3], 3), [[0], [1]], "never 1-3");
  assert.deepEqual(pack([3, 1], 3), [[0], [1]]);
  assert.deepEqual(pack([1, 1, 2], 3), [[0, 1], [2]]);
  assert.deepEqual(pack([2, 2, 1], 3), [[0], [1, 2]]);
  assert.deepEqual(pack([4], 3), [[0]]);
  assert.deepEqual(pack([], 3), []);
});

test("in two columns a row is 1-1 or a 2, and in one column every repo is alone", () => {
  const pack = (cards: number[], columns: number) => packRepos(cards.map((count) => repoSpan(count, columns)), columns);
  assert.deepEqual(pack([1, 1, 1], 2), [[0, 1], [2]]);
  assert.deepEqual(pack([2, 1], 2), [[0], [1]]);
  assert.deepEqual(pack([1, 2], 2), [[0], [1]], "a lone 1 only because the next does not fit");
  assert.deepEqual(pack([1, 1], 1), [[0], [1]]);
});

test("every row fits its columns, every repo appears once and in order, for any mix", () => {
  for (const columns of [1, 2, 3]) {
    for (let seed = 0; seed < 200; seed++) {
      const cards = Array.from({ length: 1 + (seed % 9) }, (_, i) => ((seed * 7 + i * 5) % 5));
      const spans = cards.map((count) => repoSpan(count, columns));
      const rows = packRepos(spans, columns);
      assert.deepEqual(rows.flat(), spans.map((_, i) => i));
      for (const row of rows) assert.ok(row.reduce((sum, i) => sum + spans[i], 0) <= columns);
    }
  }
});

test("a repo's width is its columns of cards plus the gaps between them", () => {
  assert.equal(spanWidth(1, 365, 12), 365);
  assert.equal(spanWidth(2, 365, 12), 742);
  assert.equal(spanWidth(3, 365, 12), 1119);
});

test("a repo's cards are its boards plus one for the agents without a board", () => {
  const entry = (board: boolean) => ({ workspace: ws("w", "p", "P", "n"), board: board ? summary() : null, agents: [] });
  const group = (...flags: boolean[]) => ({ projectId: "p", projectName: "P", workspaces: flags.map(entry), totals: { boards: 0, fullAutos: 0, active: 0, stuck: 0, agents: 0 } });
  assert.equal(cardCount(group(true)), 1);
  assert.equal(cardCount(group(true, true, false)), 3, "two boards and the chats card");
  assert.equal(cardCount(group(false, false)), 1, "chats only: one card");
});

// Des, 16 Oct: tint the whole board card very gently by mode. Manual stays
// normal; hold is yellow, spec lilac, clear the board light green, full auto green.
test("each mode but manual has its own faint tint, and manual has none", () => {
  assert.equal(MODE_TINT.manual, null);
  const tints = (["hold", "spec", "clear", "fullauto"] as const).map((mode) => MODE_TINT[mode]);
  assert.equal(new Set(tints).size, 4, "all four differ");
  for (const tint of tints) {
    const match = /^rgba\((\d+), (\d+), (\d+), (0\.\d+)\)$/.exec(tint ?? "");
    assert.ok(match, String(tint));
    assert.ok(Number(match[4]) > 0 && Number(match[4]) <= 0.12, `${tint} is very gentle`);
  }
  const [hold, spec, clear, auto] = tints.map((tint) => /rgba\((\d+), (\d+), (\d+)/.exec(tint!)!.slice(1).map(Number));
  assert.ok(hold[0] > hold[2] && hold[1] > hold[2], "hold is yellow: red and green high, blue low");
  assert.ok(spec[2] > spec[1] && spec[0] > spec[1], "spec is lilac: blue and red above green");
  assert.ok(clear[1] > clear[0] && clear[1] > clear[2], "clear is green-led");
  assert.ok(auto[1] > auto[0] && auto[1] > auto[2], "full auto is green-led");
  assert.ok(clear[0] > auto[0] && clear[2] > auto[2], "clear is the lighter green");
});

// Des, 16 Oct: "Zoe shows a stuck on the dash but its not a p0/1/2. Stucks are
// only 0/1/2s and active or fullauto."
test("a stuck item counts only for a P0-P2 objective, and only on a board that is active or on full auto", () => {
  type Board = Parameters<typeof boardStatuses>[0];
  const ticket = (id: string, status: string, priority?: number) => ({ id, status, ...(priority === undefined ? {} : { priority }) });
  const blocked = (ticketId: string) => ({ kind: "blocked", key: `blocked:${ticketId}`, ticketId, title: "t", since: "2026-10-16T10:00:00.000Z" });
  const board = (over: Record<string, unknown>) => ({ tickets: [], stuck: [], stale: false, ...over }) as unknown as Board;

  // Zoe's real board: one blocked P4 item, nothing running, no full auto.
  assert.deepEqual(boardStatuses(board({ tickets: [ticket("o8", "blocked", 4)], stuck: [blocked("o8")] }), false), [{ kind: "idle" }]);

  // The same board with work in progress: a P4 still does not count, a P1 does.
  const working = [ticket("o1", "in_progress", 1), ticket("o8", "blocked", 4), ticket("o9", "blocked", 1), ticket("o10", "blocked", 2), ticket("o11", "blocked", 3), ticket("o12", "blocked")];
  const stuck = ["o8", "o9", "o10", "o11", "o12"].map(blocked);
  assert.deepEqual(boardStatuses(board({ tickets: working, stuck }), false), [{ kind: "active", count: 1 }, { kind: "stuck", count: 2 }], "only P1 and P2 count; P3, P4 and none do not");

  // Nothing running, no full auto: even a P0 blocker is not stuck.
  assert.deepEqual(boardStatuses(board({ tickets: [ticket("o2", "blocked", 0)], stuck: [blocked("o2")] }), false), [{ kind: "idle" }]);

  // Full auto on makes the board count, with no work in progress.
  assert.deepEqual(boardStatuses(board({ tickets: [ticket("o2", "blocked", 0)], stuck: [blocked("o2")], conn: { on: true } }), false), [{ kind: "stuck", count: 1 }]);

  // A flag with no objective behind it has no priority, so it does not count.
  const manual = { kind: "manual", key: "manual:m1", id: "m1", title: "t", reason: "r", since: "x" };
  assert.deepEqual(boardStatuses(board({ tickets: [ticket("o1", "in_progress", 0)], stuck: [manual] }), false), [{ kind: "active", count: 1 }]);
  assert.deepEqual(boardStatuses(board({ tickets: [ticket("o1", "in_progress", 0), ticket("o3", "open", 2)], stuck: [{ ...manual, ticketId: "o3" }] }), false), [{ kind: "active", count: 1 }, { kind: "stuck", count: 1 }], "a flag on a P2 objective counts");
});

// PSR's report (26 Oct): the header said 24 boards where the collector found 18
// store folders, because fetchOverview answers per workspace and several
// workspaces share one worktree. A board is its store folder, never its title.
test("two workspaces on one store folder count as one board, and name each other", () => {
  const folder = "/state/proj-2f9c1a44";
  const groups = groupOverview(
    [ws("w1", "p", "Proj", "Alpha"), ws("w2", "p", "Proj", "Beta")],
    { w1: summary({ store: folder }), w2: summary({ store: folder }) },
    [],
  );
  assert.equal(groups[0].totals.boards, 1, "one store folder is one board");
  assert.equal(groups[0].workspaces.length, 1, "the card shows once");
  assert.deepEqual(groups[0].workspaces[0].sharedBy, ["Beta"], "the other workspace is named on the card");
});

test("two boards with the same title are still two boards", () => {
  const groups = groupOverview(
    [ws("w1", "p", "Proj", "Alpha"), ws("w2", "p", "Proj", "Beta")],
    { w1: summary({ store: "/state/a-1" }), w2: summary({ store: "/state/b-2" }) },
    [],
  );
  assert.equal(groups[0].totals.boards, 2, "a shared title is not a shared board");
  assert.equal(groups[0].workspaces.length, 2);
});

// Des, 26 Oct: the machine reads as Paseo's sidebar does, an icon plus a short
// code in the machine's own colour, not a long host name in plain grey.
test("a machine gets a short code and one stable colour", () => {
  assert.equal(shortLabel("MS"), "MS");
  assert.equal(shortLabel("korolev"), "KOR");
  assert.equal(shortLabel(""), "?");
  assert.equal(machineTint("MS"), machineTint("ms"), "case does not change the colour");
  assert.match(machineTint("MS"), /^#[0-9a-f]{6}$/);
  assert.notEqual(machineTint("MS"), machineTint("KLV"), "two machines do not share a colour");
});
