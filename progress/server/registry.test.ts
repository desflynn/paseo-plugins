// The Paseo agent registry: agent id → workspaceId, looked up one agent at a
// time in $PASEO_HOME/agents/<group>/<agent id>.json (one group level, plus any
// flat files, best effort). The fold's workspace-first attribution (o20)
// resolves an event's `by` through it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentWorkspaces, defaultPaseoHome } from "./registry.ts";

// The fold only ever asks about the agents named in the board's events, so the
// lookup opens that agent's file and nothing else (o24: walking all 11,000
// agent files every 30 s froze the panel for seconds).
test("agentWorkspaces resolves one agent by its file and remembers it", () => {
  const home = mkdtempSync(join(tmpdir(), "pp-registry-"));
  try {
    mkdirSync(join(home, "agents", "group-one"), { recursive: true });
    const file = join(home, "agents", "group-one", "agent-a.json");
    writeFileSync(file, JSON.stringify({ id: "agent-a", workspaceId: "ws-a" }));
    writeFileSync(join(home, "agents", "group-one", "other.json"), "{ never opened");
    const agents = agentWorkspaces(home);
    assert.equal(agents.get("agent-a"), "ws-a");
    rmSync(file);
    assert.equal(agents.get("agent-a"), "ws-a", "a found agent is not looked up again");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agentWorkspaces finds flat files and retries a missing agent only after the retry window", () => {
  const home = mkdtempSync(join(tmpdir(), "pp-registry-"));
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    let clock = 1_000;
    const agents = agentWorkspaces(home, () => clock);
    assert.equal(agents.get("agent-late"), undefined);
    writeFileSync(join(home, "agents", "agent-late.json"), JSON.stringify({ id: "agent-late", workspaceId: "ws-late" }));
    assert.equal(agents.get("agent-late"), undefined, "a miss is not retried inside the window");
    clock += 31_000;
    assert.equal(agents.get("agent-late"), "ws-late");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agentWorkspaces never follows an id out of the agents folder", () => {
  const home = mkdtempSync(join(tmpdir(), "pp-registry-"));
  try {
    mkdirSync(join(home, "agents", "g"), { recursive: true });
    writeFileSync(join(home, "outside.json"), JSON.stringify({ id: "../outside", workspaceId: "ws-out" }));
    assert.equal(agentWorkspaces(home).get("../outside"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agentWorkspaces skips what it cannot use: bad JSON, no workspaceId, no agents folder", () => {
  const home = mkdtempSync(join(tmpdir(), "pp-registry-"));
  try {
    mkdirSync(join(home, "agents", "group"), { recursive: true });
    writeFileSync(join(home, "agents", "group", "bad.json"), "{ not json");
    writeFileSync(join(home, "agents", "group", "nows.json"), JSON.stringify({ id: "nows" }));
    writeFileSync(join(home, "agents", "group", "good.json"), JSON.stringify({ id: "good", workspaceId: "ws-good" }));
    const agents = agentWorkspaces(home);
    assert.equal(agents.get("bad"), undefined);
    assert.equal(agents.get("nows"), undefined);
    assert.equal(agents.get("good"), "ws-good");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(agentWorkspaces(join(tmpdir(), "pp-registry-nope-xyz")).get("anyone"), undefined);
});

test("defaultPaseoHome honours PASEO_HOME, else ~/.paseo", () => {
  assert.equal(defaultPaseoHome({ PASEO_HOME: "/custom/paseo" }), "/custom/paseo");
  assert.equal(defaultPaseoHome({}), join(homedir(), ".paseo"));
});
