// resolveWorkspaceId reads the Paseo agent record on disk and returns the
// workspace id, or undefined on any miss. These tests run against a throwaway
// PASEO_HOME so the real ~/.paseo stays out of them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveWorkspaceId } from "./workspace.ts";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";

async function makeHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "workspace-home-"));
}

async function writeAgent(home: string, slug: string, agentId: string, record: unknown): Promise<void> {
  const dir = join(home, "agents", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${agentId}.json`), typeof record === "string" ? record : JSON.stringify(record));
}

test("returns the workspace id from the agent record", async () => {
  const home = await makeHome();
  await writeAgent(home, "some-worktree", AGENT_ID, { workspaceId: "wks_test1" });
  assert.equal(resolveWorkspaceId(AGENT_ID, home), "wks_test1");
});

test("returns undefined when no agent record exists", async () => {
  const home = await makeHome();
  assert.equal(resolveWorkspaceId(AGENT_ID, home), undefined);
  assert.equal(resolveWorkspaceId(AGENT_ID, join(home, "nowhere")), undefined);
});

test("returns undefined on unreadable JSON", async () => {
  const home = await makeHome();
  await writeAgent(home, "broken", AGENT_ID, "{not json at all");
  assert.equal(resolveWorkspaceId(AGENT_ID, home), undefined);
});

test("returns undefined when the record has no workspaceId", async () => {
  const home = await makeHome();
  await writeAgent(home, "fieldless", AGENT_ID, { name: "no scope here" });
  assert.equal(resolveWorkspaceId(AGENT_ID, home), undefined);
});

test("returns undefined for an archived agent record", async () => {
  const home = await makeHome();
  await writeAgent(home, "old", AGENT_ID, { workspaceId: "wks_old", archivedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(resolveWorkspaceId(AGENT_ID, home), undefined);
});

test("an archived record never hides a live one in another folder", async () => {
  const home = await makeHome();
  await writeAgent(home, "old", AGENT_ID, { workspaceId: "wks_old", archivedAt: "2026-01-01T00:00:00.000Z" });
  await writeAgent(home, "live", AGENT_ID, { workspaceId: "wks_live" });
  assert.equal(resolveWorkspaceId(AGENT_ID, home), "wks_live");
});

test("PASEO_HOME overrides the default home; the explicit argument wins over both", async () => {
  const envHome = await makeHome();
  const argHome = await makeHome();
  await writeAgent(envHome, "from-env", AGENT_ID, { workspaceId: "wks_env" });
  await writeAgent(argHome, "from-arg", AGENT_ID, { workspaceId: "wks_arg" });
  const saved = process.env.PASEO_HOME;
  process.env.PASEO_HOME = envHome;
  try {
    assert.equal(resolveWorkspaceId(AGENT_ID), "wks_env");
    assert.equal(resolveWorkspaceId(AGENT_ID, argHome), "wks_arg");
  } finally {
    if (saved === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = saved;
  }
});
