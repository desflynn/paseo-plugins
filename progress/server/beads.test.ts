// readBeads shells bd readonly over the repo's beads. A fake runner stands in
// for the binary, so no test touches a real beads database.
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type BdRunner, handleGetBeads, readBeads } from "./beads.ts";

const context = { paseo: {} as PluginHandlerContext["paseo"] };

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beads-root-"));
  await mkdir(join(root, ".beads"));
  return root;
}

function fake(stdout: string) {
  const calls: Array<{ file: string; args: string[]; options: { timeout?: number; maxBuffer?: number } }> = [];
  const runner: BdRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout };
  };
  return { runner, calls };
}

const failing = (error: Error & { code?: string | number }): BdRunner => async () => {
  throw error;
};

const RECORDS = JSON.stringify([
  { id: "pp-1", title: "First", status: "open", priority: 1, issue_type: "bug", updated_at: "2026-10-11T00:00:00Z", extra: "dropped" },
  { id: "pp-2", title: "Second", status: "closed", priority: 4 },
]);

test("shells bd readonly over the repo root and returns ok with mapped issues", async () => {
  const root = await repo();
  const { runner, calls } = fake(RECORDS);
  const result = await readBeads(root, runner);
  assert.deepEqual(result, {
    state: "ok",
    issues: [
      { id: "pp-1", title: "First", status: "open", priority: 1, issue_type: "bug", updated_at: "2026-10-11T00:00:00Z" },
      { id: "pp-2", title: "Second", status: "closed", priority: 4 },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "bd");
  assert.deepEqual(calls[0].args, ["--readonly", "-C", root, "list", "--json", "--limit", "0"]);
  assert.deepEqual(calls[0].options, { timeout: 10_000, maxBuffer: 5 * 1024 * 1024 });
});

test("no .beads folder means none, without shelling bd", async () => {
  const root = await mkdtemp(join(tmpdir(), "beads-empty-"));
  const { runner, calls } = fake(RECORDS);
  assert.deepEqual(await readBeads(root, runner), { state: "none" });
  assert.equal(calls.length, 0);
});

test("a missing bd binary means none", async () => {
  const root = await repo();
  const missing = Object.assign(new Error("spawn bd ENOENT"), { code: "ENOENT" });
  assert.deepEqual(await readBeads(root, failing(missing)), { state: "none" });
});

test("a bd failure surfaces as error with the message", async () => {
  const root = await repo();
  const boom = Object.assign(new Error("bd: database is locked"), { code: 1 });
  const result = await readBeads(root, failing(boom));
  assert.equal(result.state, "error");
  if (result.state === "error") assert.match(result.message, /database is locked/);
});

test("output that is not a JSON array is an error", async () => {
  const root = await repo();
  const result = await readBeads(root, fake("{{{ not json").runner);
  assert.equal(result.state, "error");
});

// Amended by plan revision 7 (D-3): was "an empty list means the calm none
// state" pinning {state:"none"}; the owner's proof cycle ruled an empty read
// is ok with zero issues and none stays only for missing bd / no .beads/.
test("an empty list is ok with zero issues — distinct from none (rev 7, D-3)", async () => {
  const root = await repo();
  assert.deepEqual(await readBeads(root, fake("[]").runner), { state: "ok", issues: [] });
  const bare = await mkdtemp(join(tmpdir(), "beads-empty-"));
  assert.deepEqual(await readBeads(bare, fake("[]").runner), { state: "none" });
});

// PROOF FIX (revision 7, D-3): an EMPTY list is not none — a successful read
// returns ok with an empty list; none stays only for missing bd, no .beads/.
test("a successful empty read is ok with an empty list, not none (D-3)", async () => {
  const root = await repo();
  const result = await readBeads(root, fake("[]").runner);
  assert.deepEqual(result, { state: "ok", issues: [] });
});

test("a record missing a required field is skipped, the rest stay honest", async () => {
  const root = await repo();
  const partial = JSON.stringify([{ id: "pp-9", status: "open" }, { id: "pp-1", title: "Good", status: "open", priority: 2 }]);
  const result = await readBeads(root, fake(partial).runner);
  assert.deepEqual(result, { state: "ok", issues: [{ id: "pp-1", title: "Good", status: "open", priority: 2 }] });
});

test("the rpc handler reads the workspace's repo", async () => {
  const root = await repo();
  const { runner } = fake(RECORDS);
  const result = await handleGetBeads({ workspaceId: "ws-1", workspaceDirectory: root }, context, runner);
  assert.equal(result.state, "ok");
});
