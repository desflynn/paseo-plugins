// The Paseo agent registry: agent id → workspaceId, read from
// $PASEO_HOME/agents/<group>/<agent>.json (one group level, plus any flat
// files, best effort — one bad file hides no registry). The fold's
// workspace-first attribution (o20) resolves an event's `by` through it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentWorkspaceMap, defaultPaseoHome } from "./registry.ts";

test("maps each agent file's id to its workspaceId across group folders", () => {
  const home = mkdtempSync(join(tmpdir(), "pp-registry-"));
  try {
    mkdirSync(join(home, "agents", "Users-des-dev-one"), { recursive: true });
    writeFileSync(join(home, "agents", "Users-des-dev-one", "a1.json"),
      JSON.stringify({ id: "agent-a", workspaceId: "ws-a" }));
    mkdirSync(join(home, "agents", "Users-des-dev-two"), { recursive: true });
    writeFileSync(join(home, "agents", "Users-des-dev-two", "b2.json"),
      JSON.stringify({ id: "agent-b", workspaceId: "ws-b" }));
    const map = agentWorkspaceMap(home);
    assert.equal(map.get("agent-a"), "ws-a");
    assert.equal(map.get("agent-b"), "ws-b");
    assert.equal(map.size, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("also reads flat agent files directly under agents/", () => {
  const home = mkdtempSync(join(tmpdir(), "pp-registry-"));
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "flat.json"),
      JSON.stringify({ id: "agent-flat", workspaceId: "ws-flat" }));
    assert.equal(agentWorkspaceMap(home).get("agent-flat"), "ws-flat");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skips entries it cannot use: bad JSON, missing workspaceId, missing id", () => {
  const home = mkdtempSync(join(tmpdir(), "pp-registry-"));
  try {
    mkdirSync(join(home, "agents", "group"), { recursive: true });
    writeFileSync(join(home, "agents", "group", "bad.json"), "{ not json");
    writeFileSync(join(home, "agents", "group", "nows.json"), JSON.stringify({ id: "agent-nows" }));
    writeFileSync(join(home, "agents", "group", "noid.json"), JSON.stringify({ workspaceId: "ws-x" }));
    writeFileSync(join(home, "agents", "group", "good.json"),
      JSON.stringify({ id: "agent-good", workspaceId: "ws-good" }));
    const map = agentWorkspaceMap(home);
    assert.deepEqual([...map.entries()], [["agent-good", "ws-good"]]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing agents directory reads as an empty registry", () => {
  assert.equal(agentWorkspaceMap(join(tmpdir(), "pp-registry-nope-xyz")).size, 0);
});

test("defaultPaseoHome honours PASEO_HOME, else ~/.paseo", () => {
  assert.equal(defaultPaseoHome({ PASEO_HOME: "/custom/paseo" }), "/custom/paseo");
  assert.equal(defaultPaseoHome({}), join(homedir(), ".paseo"));
});
