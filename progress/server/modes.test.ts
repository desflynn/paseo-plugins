import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conn, Hold } from "../shared/dashboard.ts";
import { autoUnderneath, BOARD_MODES, isActiveMode, modeOf, ownerAgent, planModeChange, workspaceOwner } from "../shared/modes.ts";
import type { AgentRef } from "../shared/overview.ts";

const conn = (clear?: boolean): Conn => ({ on: true, budget: 2, mode: "live", since: "x", nextNudgeAt: "y", ...(clear ? { clear: true } : {}) }) as Conn;
const hold = (kind: Hold["kind"]): Hold => ({ on: true, kind, since: "x" });

// Des, 16 Oct: five board states. A hold only pauses full auto, so the
// conn lives underneath it and a held board still remembers which auto it had.
test("a board reads as one of five states, a hold winning the display and conn staying underneath", () => {
  assert.deepEqual(BOARD_MODES, ["manual", "hold", "spec", "clear", "fullauto"]);
  assert.equal(modeOf(null), "manual");
  assert.equal(modeOf({}), "manual");
  assert.equal(modeOf({ conn: conn() }), "fullauto");
  assert.equal(modeOf({ conn: conn(true) }), "clear");
  assert.equal(modeOf({ hold: hold("closed") }), "hold");
  assert.equal(modeOf({ hold: hold("speccing") }), "spec");
  assert.equal(modeOf({ conn: conn(), hold: hold("speccing") }), "spec", "spec over full auto shows spec");
  assert.equal(autoUnderneath({ conn: conn(), hold: hold("speccing") }), "fullauto");
  assert.equal(autoUnderneath({ conn: conn(true), hold: hold("closed") }), "clear");
  assert.equal(autoUnderneath({ hold: hold("closed") }), null);
  assert.deepEqual(BOARD_MODES.filter(isActiveMode), ["clear", "fullauto"]);
});

test("going to hold or spec writes the hold and pings nobody; staying put does nothing", () => {
  assert.deepEqual(planModeChange({ conn: conn() }, "hold"), { hold: { kind: "closed" }, ping: null });
  assert.deepEqual(planModeChange({}, "spec"), { hold: { kind: "speccing" }, ping: null });
  assert.deepEqual(planModeChange({ hold: hold("closed") }, "spec"), { hold: { kind: "speccing" }, ping: null }, "hold to spec swaps the kind");
  assert.deepEqual(planModeChange({ conn: conn() }, "fullauto"), { hold: "none", ping: null });
  assert.deepEqual(planModeChange({}, "manual"), { hold: "none", ping: null });
});

test("an idle board going active pings its owner, with the command that takes full auto on", () => {
  const plan = planModeChange({}, "fullauto");
  assert.equal(plan.hold, "none");
  assert.match(plan.ping ?? "", /^\/fullauto — Des switched this board to Full auto from the Progress page\. Continue\.$/);
  assert.match(planModeChange({}, "clear").ping ?? "", /^\/fullauto clear — Des switched this board to Clear the board/);
  assert.match(planModeChange({ hold: hold("speccing") }, "fullauto").ping ?? "", /^\/fullauto — /, "no full auto underneath: the agent has to take it on");
});

test("lifting a hold off a board that still has its full auto underneath pings Continue with no command", () => {
  const plan = planModeChange({ conn: conn(), hold: hold("speccing") }, "fullauto");
  assert.equal(plan.hold, "clear");
  assert.equal(plan.ping, "Des switched this board to Full auto from the Progress page. Continue.");
  assert.equal(planModeChange({ conn: conn(true), hold: hold("closed") }, "clear").ping, "Des switched this board to Clear the board from the Progress page. Continue.");
});

test("changing between the two autos re-runs the command, since only the seat can change its conn", () => {
  assert.match(planModeChange({ conn: conn() }, "clear").ping ?? "", /^\/fullauto clear — /);
  assert.match(planModeChange({ conn: conn(true) }, "fullauto").ping ?? "", /^\/fullauto — /);
  assert.match(planModeChange({ conn: conn(), hold: hold("closed") }, "clear").ping ?? "", /^\/fullauto clear — /, "a held board under the other auto");
});

test("going manual lifts any hold and, if a full auto is on, tells the seat to turn it off", () => {
  assert.deepEqual(planModeChange({ hold: hold("closed") }, "manual"), { hold: "clear", ping: null });
  const off = planModeChange({ conn: conn() }, "manual");
  assert.equal(off.hold, "none");
  assert.match(off.ping ?? "", /^\/fullauto off — Des switched this board to Manual from the Progress page\./);
  assert.match(planModeChange({ conn: conn(true), hold: hold("speccing") }, "manual").ping ?? "", /^\/fullauto off — /);
  assert.equal(planModeChange({ conn: conn(true), hold: hold("speccing") }, "manual").hold, "clear");
});

test("a workspace's owner is picked from the raw agent list: its own seats only, never a helper or a closed agent", () => {
  const entry = (id: string, workspaceId: string | null, title: string, status = "idle", parentAgentId: string | null = null) => ({ agent: { id, workspaceId, title, status, parentAgentId } });
  const list = [
    entry("x1", "w2", "PP Head Guy"),
    entry("a1", "w1", "Zoe"),
    entry("a2", "w1", "HHC3 Head Guy ♾️ 🟧"),
    entry("h1", "w1", "helper", "running", "a2"),
    entry("c1", "w1", "Old", "closed"),
    entry("n1", null, "No workspace"),
  ];
  assert.equal(workspaceOwner(list, "w1")?.id, "a2", "the Head Guy wearing the full auto mark beats the other seat");
  assert.equal(workspaceOwner(list, "w2")?.id, "x1");
  assert.equal(workspaceOwner(list, "w9"), null, "no agents there, no owner");
  assert.equal(workspaceOwner([], "w1"), null);
});

test("the owner to ping is the live top-level seat wearing the full auto icon, else a Head Guy, else the busiest", () => {
  const agent = (id: string, title: string | null, status: AgentRef["status"] = "idle", parentAgentId: string | null = null): AgentRef => ({ id, workspaceId: "w", status, title, parentAgentId });
  assert.equal(ownerAgent([]), null);
  assert.equal(ownerAgent([agent("a", "helper", "running", "p")]), null, "a helper is never the owner");
  assert.equal(ownerAgent([agent("a", "Zoe"), agent("b", "🧔‍♂️HHC3 Head Guy ♾️🏁 🟧"), agent("c", "HHC3 Head Guy")])?.id, "b");
  assert.equal(ownerAgent([agent("a", "Zoe"), agent("c", "PP Head Guy 🟧")])?.id, "c");
  assert.equal(ownerAgent([agent("a", "Zoe"), agent("d", "Other", "running")])?.id, "d");
  assert.equal(ownerAgent([agent("a", "Zoe", "closed")]), null, "a closed seat cannot be pinged");
});
