// The four new verbs and the CLI scope leg: `ticket claim`, `ticket done`,
// `--ref` on add/update, `show --mine` / `--all` / `--json`. Every written
// event carries `ws` next to `by`, resolved once per call from the agent
// record. Plain `show` stays byte-identical to 0.4.0.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runCli } from "./cli.ts";
import { findRoot } from "./paths.ts";
import { findStore, git, outsideDirectory } from "./store.ts";
import { PROGRESS_FILE_NAME } from "../shared/events.ts";

// Working files live under a throwaway home, like progress.test.ts.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const HOME = await mkdtemp(join(tmpdir(), "progress-verbs-home-"));
process.env.HOME = HOME;
// The workspace resolver reads PASEO_HOME; each test writes agent records here.
const PASEO_HOME = await mkdtemp(join(tmpdir(), "progress-verbs-paseo-"));
process.env.PASEO_HOME = PASEO_HOME;

const T0 = Date.parse("2026-09-27T19:59:00.000Z");
const minutes = (count: number) => new Date(T0 + count * 60_000);

async function worktree(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "progress-verbs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, ["init", "-q"]);
  const store = outsideDirectory(directory);
  const output: string[] = [];
  return {
    directory,
    store,
    output,
    async runAs(agentId: string | undefined, ...argv: string[]) {
      output.length = 0;
      const code = await runCli(argv, { cwd: directory, now: () => minutes(1), out: (line) => output.push(line), agentId });
      return { code, text: output.join("\n") };
    },
    // The last event in the file, as the CLI wrote it.
    async lastEvent() {
      const text = await readFile(join(await storeHome(store), PROGRESS_FILE_NAME), "utf8");
      const lines = text.trimEnd().split("\n");
      return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    },
  };
}

// findStore's folder, computed once per store path.
async function storeHome(store: string): Promise<string> {
  return store;
}

// One agent record so the resolver scopes that agent to a workspace.
async function seat(agentId: string, workspaceId: string) {
  const slug = `slug-${agentId}`;
  await mkdir(join(PASEO_HOME, "agents", slug), { recursive: true });
  await writeFile(join(PASEO_HOME, "agents", slug, `${agentId}.json`), JSON.stringify({ workspaceId }));
}

test("ticket claim sets the ticket working and stamps by and ws", async (t) => {
  const w = await worktree(t);
  await seat("agent-a", "ws-a");
  await w.runAs("agent-a", "start", "Run");
  await w.runAs("agent-a", "ticket", "add", "Wire the ledger", "--estimate", "60");
  const { code, text } = await w.runAs("agent-a", "ticket", "claim", "T01", "--stage", "Build");
  assert.equal(code, 0, text);
  assert.match(text, /Claimed o1/);
  const event = await w.lastEvent();
  assert.equal(event.type, "ticket.update");
  assert.equal(event.status, "in_progress");
  assert.equal(event.stage, "Build");
  assert.equal(event.by, "agent-a");
  assert.equal(event.ws, "ws-a");
});

test("ticket done sets the ticket done", async (t) => {
  const w = await worktree(t);
  await w.runAs(undefined, "start", "Run");
  await w.runAs(undefined, "ticket", "add", "Post the letter", "--estimate", "30");
  const { code, text } = await w.runAs(undefined, "ticket", "done", "T01", "--note", "in the post");
  assert.equal(code, 0, text);
  assert.match(text, /Done o1|Updated o1/);
  const event = await w.lastEvent();
  assert.equal(event.type, "ticket.update");
  assert.equal(event.status, "closed");
  assert.equal(event.closeReason, "done");
  assert.equal(event.note, "in the post");
});

test("--ref on ticket add and ticket update lands on the ticket", async (t) => {
  const w = await worktree(t);
  await w.runAs(undefined, "start", "Run");
  const { code, text } = await w.runAs(undefined, "ticket", "add", "From a bead", "--estimate", "45", "--ref", "bead:rvr-1");
  assert.equal(code, 0, text);
  assert.match(text, /ref bead:rvr-1/);
  const added = await w.lastEvent();
  assert.deepEqual(added.refs, ["bead:rvr-1"]);
  const update = await w.runAs(undefined, "ticket", "update", "T01", "--ref", "gh:owner/repo#7");
  assert.equal(update.code, 0, update.text);
  const event = await w.lastEvent();
  assert.deepEqual(event.refs, ["gh:owner/repo#7"]);
});

// GOLDEN captured from the pre-change CLI (0.4.0 behaviour) for these events.
const GOLDEN = (root: string) => `${"Worktree: " + root}\n\nLedger run\n0 of 1 objective done\nLast updated Sep 27, 9:00 PM (just now)\n0% of estimated work done, 0 min of 1 h\n\nObjectives\n  o1  Open  1 h  Wire the ledger`;

test("plain show output is byte-identical to 0.4.0, scoped or not", async (t) => {
  const w = await worktree(t);
  await w.runAs(undefined, "start", "Ledger run");
  await w.runAs(undefined, "ticket", "add", "Wire the ledger", "--estimate", "60");
  const { code, text } = await w.runAs("agent-a", "show");
  assert.equal(code, 0);
  // No agent record for agent-a, so the call is unscoped: exactly 0.4.0.
  assert.equal(text, GOLDEN(w.directory));
  // A record scoping agent-a to one workspace must not change a file whose
  // only run is that workspace's: the swap resets nothing.
  await seat("agent-a", "ws-a");
  const scoped = await w.runAs("agent-a", "show");
  assert.equal(scoped.text, GOLDEN(w.directory));
});

test("show --mine shows only this agent's work; show --all shows every workspace", async (t) => {
  const w = await worktree(t);
  await seat("agent-a", "ws-a");
  await seat("agent-b", "ws-b");
  await w.runAs("agent-a", "start", "Workspace A");
  await w.runAs("agent-a", "ticket", "add", "A ticket", "--estimate", "60");
  await w.runAs("agent-b", "start", "Workspace B");
  await w.runAs("agent-b", "ticket", "add", "B ticket", "--estimate", "30");
  const mine = await w.runAs("agent-a", "show", "--mine");
  assert.equal(mine.code, 0, mine.text);
  assert.match(mine.text, /A ticket/);
  assert.doesNotMatch(mine.text, /B ticket/);
  const all = await w.runAs("agent-a", "show", "--all");
  assert.equal(all.code, 0, all.text);
  assert.match(all.text, /Workspace B/);
  assert.match(all.text, /B ticket/);
});

test("show --json prints machine-readable output", async (t) => {
  const w = await worktree(t);
  await w.runAs(undefined, "start", "Run");
  await w.runAs(undefined, "ticket", "add", "A ticket", "--estimate", "60");
  const { code, text } = await w.runAs(undefined, "show", "--json");
  assert.equal(code, 0, text);
  const parsed = JSON.parse(text) as { worktree?: string; dashboard?: { run?: { title?: string }; tickets?: Array<{ id?: string }> } };
  assert.equal(parsed.dashboard?.run?.title, "Run");
});

// OWNER UNION call-site (revision 5 GO): show --all folds every workspace's
// current run together — both scopes' tickets in one board.
test("show --all shows both workspaces' tickets in one board", async (t) => {
  const w = await worktree(t);
  await seat("agent-a", "ws-a");
  await seat("agent-b", "ws-b");
  await w.runAs("agent-a", "start", "Workspace A");
  await w.runAs("agent-a", "ticket", "add", "A ticket", "--estimate", "60");
  await w.runAs("agent-b", "start", "Workspace B");
  await w.runAs("agent-b", "ticket", "add", "B ticket", "--estimate", "30");
  const all = await w.runAs("agent-a", "show", "--all");
  assert.equal(all.code, 0, all.text);
  assert.match(all.text, /A ticket/, "workspace A's ticket must show in All");
  assert.match(all.text, /B ticket/, "workspace B's ticket must show in All");
  assert.match(all.text, /0 of 2 objectives done/, "counts over the union, not one run");
  // The workspace-scoped view stays its own run: A's board hides B's ticket.
  const plain = await w.runAs("agent-a", "show");
  assert.match(plain.text, /A ticket/);
  assert.doesNotMatch(plain.text, /B ticket/);
});

// ── First-class reallocate (o21 / O3000) ───────────────────────────

test("ticket move writes an append-only move event stamped by and ws", async (t) => {
  const w = await worktree(t);
  await seat("agent-a", "ws-a");
  await w.runAs("agent-a", "start", "Run");
  await w.runAs("agent-a", "ticket", "add", "Wrong desk", "--estimate", "60");
  const { code, text } = await w.runAs("agent-a", "ticket", "move", "T01", "--to", "ws-b");
  assert.equal(code, 0, text);
  assert.match(text, /Moved o1/);
  const event = await w.lastEvent();
  assert.equal(event.type, "ticket.move");
  // The CLI writes the migrated id, like every other ticket verb.
  assert.equal(event.id, "o1");
  assert.equal(event.to, "ws-b");
  assert.equal(event.by, "agent-a");
  assert.equal(event.ws, "ws-a");
});

test("ticket move takes the ticket off the source board and puts it on the target's", async (t) => {
  const w = await worktree(t);
  await seat("agent-a", "ws-a");
  await seat("agent-b", "ws-b");
  await w.runAs("agent-a", "start", "Run");
  await w.runAs("agent-a", "ticket", "add", "Traveller", "--estimate", "60");
  const moved = await w.runAs("agent-a", "ticket", "move", "T01", "--to", "ws-b");
  assert.equal(moved.code, 0, moved.text);
  const a = await w.runAs("agent-a", "show");
  assert.doesNotMatch(a.text, /Traveller/, "the source board must lose the ticket");
  const b = await w.runAs("agent-b", "show");
  assert.match(b.text, /Traveller/, "the target board must gain the ticket");
});

test("claim-from-all claims a ticket from another workspace into the invoker's", async (t) => {
  const w = await worktree(t);
  await seat("agent-a", "ws-a");
  await seat("agent-b", "ws-b");
  await w.runAs("agent-a", "start", "Run");
  await w.runAs("agent-a", "ticket", "add", "Foreigner", "--estimate", "60");
  const claimed = await w.runAs("agent-b", "ticket", "claim-from-all", "T01");
  assert.equal(claimed.code, 0, claimed.text);
  assert.match(claimed.text, /Claimed o1/);
  const event = await w.lastEvent();
  assert.equal(event.type, "ticket.move");
  assert.equal(event.to, "ws-b", "--to defaults to the invoking workspace");
  const b = await w.runAs("agent-b", "show");
  assert.match(b.text, /Foreigner/);
  const a = await w.runAs("agent-a", "show");
  assert.doesNotMatch(a.text, /Foreigner/);
});

test("ticket move refuses a no-op move; claim-from-all needs a workspace", async (t) => {
  const w = await worktree(t);
  await seat("agent-a", "ws-a");
  await w.runAs("agent-a", "start", "Run");
  await w.runAs("agent-a", "ticket", "add", "Homebody", "--estimate", "60");
  const noop = await w.runAs("agent-a", "ticket", "move", "T01", "--to", "ws-a");
  assert.equal(noop.code, 1);
  assert.match(noop.text, /already on workspace ws-a/);
  const noSeat = await w.runAs(undefined, "ticket", "claim-from-all", "T01");
  assert.equal(noSeat.code, 1);
  assert.match(noSeat.text, /needs a Paseo agent/);
});
