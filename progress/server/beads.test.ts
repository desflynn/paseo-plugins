// readBeads shells bd readonly over the repo's beads. A fake runner stands in
// for the binary, so no test touches a real beads database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { type BdRunner, closeBackingBeads, handleGetBeads, promoteBead, type ProgressCliRunner, readBeadDetail, readBeads, writeBeadStatus } from "./beads.ts";
import { runCli } from "./cli.ts";
import { ticketName } from "../shared/dashboard.ts";

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
  { id: "pp-2", title: "Second", status: "closed", priority: 4, close_reason: "done" },
]);

// O3000 (o30): bd emits `parent` on child beads. If the mapper drops it, every
// bead reaches the panel parentless and no list can ever nest — exactly the
// defect that shipped flat lists everywhere while the client code was right.
test("a bd record's parent link survives the read (o30)", async () => {
  const root = await repo();
  const { runner } = fake(JSON.stringify([
    { id: "hhc3-epic", title: "Sprint: mail ingest reliability", status: "in_progress", priority: 1 },
    { id: "hhc3-deor", title: "Clear stale parser fields", status: "open", priority: 1, parent: "hhc3-epic" },
  ]));
  const result = await readBeads(root, runner);
  assert.equal(result.state, "ok");
  assert.equal(result.issues[1]?.parent, "hhc3-epic", "the parent field must ride through to the panel");
});

test("shells bd readonly over the repo root and returns ok with mapped issues", async () => {
  const root = await repo();
  const { runner, calls } = fake(RECORDS);
  const result = await readBeads(root, runner);
  // O2600 (o17): the list carries closed beads too (--all), so the panel's
  // done-sink has the record to fold; the client does the sinking.
  assert.deepEqual(result, {
    state: "ok",
    issues: [
      { id: "pp-1", title: "First", status: "open", priority: 1, issue_type: "bug", updated_at: "2026-10-11T00:00:00Z" },
      { id: "pp-2", title: "Second", status: "closed", priority: 4, close_reason: "done" },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "bd");
  assert.deepEqual(calls[0].args, ["--readonly", "-C", root, "list", "--json", "--all", "--limit", "0"]);
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

// ── T13 (O2200): the bead detail sheet ─────────────────────────────
// bd's own verbs drive it: show --json for the record, close --reason and
// update --status for the status write, and the existing ticket-add --ref
// path for the upgrade. Integration tests run a REAL bd against a temp
// database (mktemp + bd init); the repo's own .beads is never touched.

const runBd = promisify(execFile);

// A real temp bd database, so the mapping proves itself against the binary.
async function beadsRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beads-detail-"));
  await runBd("bd", ["init"], { cwd: root });
  return root;
}

async function createBead(root: string, title: string, description?: string, priority?: number): Promise<string> {
  const args = ["-C", root, "create", title];
  if (description !== undefined) args.push("-d", description);
  if (priority !== undefined) args.push("--priority", String(priority));
  await runBd("bd", args);
  const { stdout } = await runBd("bd", ["--readonly", "-C", root, "list", "--json"]);
  const issues = JSON.parse(stdout) as Array<{ id: string; title: string }>;
  return issues.find((issue) => issue.title === title)!.id;
}

test("readBeadDetail shells bd readonly show --json and maps the full record", async () => {
  const root = await repo();
  const { runner, calls } = fake(JSON.stringify([{
    id: "pp-1", title: "First", status: "open", priority: 1, issue_type: "bug",
    description: "The relay.", owner: "des@desflynn.com", created_at: "2026-10-11T00:00:00Z",
    created_by: "Des Flynn", close_reason: undefined, extra: "dropped",
  }]));
  const result = await readBeadDetail(root, "pp-1", runner);
  assert.deepEqual(result, {
    state: "ok",
    bead: {
      id: "pp-1", title: "First", status: "open", priority: 1, issue_type: "bug",
      description: "The relay.", owner: "des@desflynn.com", created_at: "2026-10-11T00:00:00Z",
      created_by: "Des Flynn",
    },
  });
  assert.deepEqual(calls[0].args, ["--readonly", "-C", root, "show", "pp-1", "--json"]);
});

test("readBeadDetail maps a real bd record from a temp database", async () => {
  const root = await beadsRepo();
  const id = await createBead(root, "Swap the pump relay", "Relay clicks twice then dies.", 1);
  const result = await readBeadDetail(root, id);
  assert.equal(result.state, "ok");
  if (result.state === "ok") {
    assert.equal(result.bead.title, "Swap the pump relay");
    assert.equal(result.bead.description, "Relay clicks twice then dies.");
    assert.equal(result.bead.priority, 1);
    assert.equal(result.bead.status, "open");
  }
});

test("an unknown bead id is an error carrying bd's own message", async () => {
  const root = await repo();
  const { runner } = fake(JSON.stringify({ error: "no issues found matching the provided IDs" }));
  const result = await readBeadDetail(root, "pp-404", runner);
  assert.equal(result.state, "error");
  if (result.state === "error") assert.match(result.message, /no issues found/);
});

test("no .beads folder means none, without shelling bd (detail)", async () => {
  const root = await mkdtemp(join(tmpdir(), "beads-empty-"));
  const { runner, calls } = fake("[]");
  assert.deepEqual(await readBeadDetail(root, "pp-1", runner), { state: "none" });
  assert.equal(calls.length, 0);
});

test("writeBeadStatus closes through bd close with the reason — a write, never --readonly", async () => {
  const root = await repo();
  const { runner, calls } = fake("");
  const result = await writeBeadStatus(root, "pp-1", "closed", "done for now", runner);
  assert.deepEqual(result, { state: "ok" });
  assert.deepEqual(calls[0].args, ["-C", root, "close", "pp-1", "--reason", "done for now"]);
});

test("writeBeadStatus moves the other statuses through bd update --status", async () => {
  const root = await repo();
  const { runner, calls } = fake("");
  assert.deepEqual(await writeBeadStatus(root, "pp-1", "in_progress", undefined, runner), { state: "ok" });
  assert.deepEqual(calls[0].args, ["-C", root, "update", "pp-1", "--status", "in_progress"]);
  assert.deepEqual(await writeBeadStatus(root, "pp-2", "open", undefined, runner), { state: "ok" });
  assert.deepEqual(calls[1].args, ["-C", root, "update", "pp-2", "--status", "open"]);
});

test("writeBeadStatus round-trips a real bead closed and open again", async () => {
  const root = await beadsRepo();
  const id = await createBead(root, "Log rotation", "Writes twice per night.");
  assert.deepEqual(await writeBeadStatus(root, id, "closed", "done ages ago"), { state: "ok" });
  const closed = await readBeadDetail(root, id);
  assert.equal(closed.state === "ok" ? closed.bead.status : "", "closed");
  assert.equal(closed.state === "ok" ? closed.bead.close_reason : "", "done ages ago");
  assert.deepEqual(await writeBeadStatus(root, id, "open"), { state: "ok" });
  const reopened = await readBeadDetail(root, id);
  assert.equal(reopened.state === "ok" ? reopened.bead.status : "", "open");
});

test("no .beads folder means the write refuses as none", async () => {
  const root = await mkdtemp(join(tmpdir(), "beads-empty-"));
  const { runner, calls } = fake("");
  assert.deepEqual(await writeBeadStatus(root, "pp-1", "closed", "x", runner), { state: "none" });
  assert.equal(calls.length, 0);
});

test("promoteBead adds a ticket through the CLI with the bead's title and ref", async () => {
  const root = await repo();
  const { runner } = fake(JSON.stringify([{ id: "pp-1", title: "Swap the pump relay", status: "open" }]));
  const calls: Array<{ argv: string[]; options: { cwd: string } }> = [];
  const cli: ProgressCliRunner = async (argv, options) => {
    calls.push({ argv, options });
    return { code: 0, out: ["Added T07: Swap the pump relay (60 min)"] };
  };
  const result = await promoteBead(root, "pp-1", runner, cli);
  assert.deepEqual(result, { state: "ok", ticketId: "T07" });
  assert.deepEqual(calls, [{
    argv: ["ticket", "add", "Swap the pump relay", "--estimate", "60", "--ref", "bead:pp-1"],
    options: { cwd: root },
  }]);
});

test("promoteBead writes into the workspace it was pressed in", async () => {
  const root = await repo();
  const { runner } = fake(JSON.stringify([{ id: "pp-1", title: "Swap the pump relay", status: "open" }]));
  const seen: Array<{ cwd: string; workspaceId?: string }> = [];
  const cli: ProgressCliRunner = async (_argv, options) => {
    seen.push(options);
    return { code: 0, out: ["Added o7: Swap the pump relay (60 min)"] };
  };
  await promoteBead(root, "pp-1", runner, cli, "/Users/des/dev/hhc3");
  assert.deepEqual(seen, [{ cwd: root, workspaceId: "/Users/des/dev/hhc3" }], "the panel's workspace rides to the CLI, or the ticket lands on the unscoped board");
});

test("promoteBead refuses when the bead cannot be read", async () => {
  const root = await repo();
  const missing = Object.assign(new Error("spawn bd ENOENT"), { code: "ENOENT" });
  let cliRan = false;
  const cli: ProgressCliRunner = async () => { cliRan = true; return { code: 0, out: [] }; };
  assert.deepEqual(await promoteBead(root, "pp-1", failing(missing), cli), { state: "none" });
  assert.equal(cliRan, false, "no bead, no CLI run");
});

test("a failing CLI run surfaces as an error with its output", async () => {
  const root = await repo();
  const { runner } = fake(JSON.stringify([{ id: "pp-1", title: "T", status: "open" }]));
  const cli: ProgressCliRunner = async () => ({ code: 1, out: ["Missing --estimate <minutes>."] });
  const result = await promoteBead(root, "pp-1", runner, cli);
  assert.equal(result.state, "error");
  if (result.state === "error") assert.match(result.message, /Missing --estimate/);
});

test("promoteBead carries a real temp-db bead's id in the ref", async () => {
  const root = await beadsRepo();
  const id = await createBead(root, "Upgrade me", "Straight through.", 2);
  const calls: Array<{ argv: string[] }> = [];
  const cli: ProgressCliRunner = async (argv) => { calls.push({ argv }); return { code: 0, out: ["Added T01: Upgrade me (60 min)"] }; };
  const result = await promoteBead(root, id, undefined, cli);
  assert.equal(result.state, "ok");
  assert.equal(calls[0].argv[calls[0].argv.indexOf("--ref") + 1], `bead:${id}`);
});

// The upgrade flow end to end (O2000): the detail view's Upgrade button
// promotes the bead through the real CLI — real temp beads db, real board
// store, no stubs — and the bead stays on the Beads tab afterwards. The
// store keys off the temp root's realpath, so nothing outside /tmp is touched.
test("the upgrade flow end to end: bead becomes an o-number objective, bead still listed", async () => {
  const root = await beadsRepo();
  const id = await createBead(root, "Fix the pump relay", "Straight through.", 2);
  const result = await promoteBead(root, id);
  assert.equal(result.state, "ok");
  const ticketId = (result as { state: "ok"; ticketId: string }).ticketId;
  assert.match(ticketId, /^o\d+$/, "the promotion lands as an o-number objective");

  // The board: show --json over the temp store carries the promoted
  // objective with its bead linkage, named from the ref, never typed.
  const out: string[] = [];
  const code = await runCli(["show", "--json"], { cwd: root, out: (line: string) => out.push(line) });
  assert.equal(code, 0);
  const { dashboard } = JSON.parse(out.join("\n")) as { dashboard: { tickets: Array<{ id: string; title: string; refs?: string[] }> } };
  const ticket = dashboard.tickets.find((candidate) => candidate.id === ticketId);
  assert.ok(ticket, "the promoted objective is on the Tickets board");
  assert.ok(ticket.refs?.includes(`bead:${id}`), "the bead linkage rides the ticket as a ref");
  const name = ticketName({ id: ticket.id, title: ticket.title, ref: undefined, refs: ticket.refs });
  assert.ok(name.startsWith(`${ticketId}-`), "the stored name opens with the o-number");
  assert.ok(name.includes(id), "the stored name carries the bead slug");
  assert.ok(name.endsWith("Fix the pump relay"), "the stored name ends with the typed title");

  // The Beads tab: promotion promotes; it does not close. The bead still shows.
  const beads = await readBeads(root);
  assert.equal(beads.state, "ok");
  if (beads.state === "ok") {
    assert.ok(beads.issues.some((issue) => issue.id === id), "the backing bead still lists after promotion");
  }
});

// --- O2100 cascade closeouts, beads side only (GitHub is later) ---

// RED: an objective carrying a bead ref closes its backing bead engine-side,
// with the close reason carried across, through the real CLI and a real temp
// beads db.
test("closing an objective closes its backing bead with the matching reason", async () => {
  const root = await beadsRepo();
  const id = await createBead(root, "Backed objective", "Closes with its objective.", 1);
  const out: string[] = [];
  const line = (text: string) => out.push(text);
  assert.equal(await runCli(["start", "Cascade"], { cwd: root, out: line }), 0);
  assert.equal(await runCli(["ticket", "add", "Ship the thing", "--estimate", "30", "--ref", `bead:${id}`], { cwd: root, out: line }), 0);
  assert.equal(await runCli(["ticket", "done", "o1"], { cwd: root, out: line }), 0, "the objective close itself succeeds");
  const { stdout } = await runBd("bd", ["--readonly", "-C", root, "list", "--json", "--all"]);
  const bead = (JSON.parse(stdout) as Array<{ id: string; status: string; close_reason?: string }>).find((issue) => issue.id === id);
  assert.ok(bead, "the backing bead is still in the db");
  assert.equal(bead!.status, "closed", "the cascade closed the backing bead");
  assert.equal(bead!.close_reason, "done", "the close reason matches the objective's");
});

// RED: a closeout with no bead linkage spawns bd exactly zero times.
test("a beadless closeout touches nothing", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: BdRunner = async (file, args) => { calls.push({ file, args }); return { stdout: "[]" }; };
  assert.deepEqual(await closeBackingBeads("/tmp", [], "done", runner), []);
  assert.deepEqual(await closeBackingBeads("/tmp", ["teams:message-1", "gh:acme/widget#7"], "done", runner), []);
  assert.deepEqual(calls, [], "no bd spawn without a bead ref");
});

// RED: the engine-side cascade fails soft — a bd fault comes back as a
// logged failure, never as a throw, and never blocks the close.
test("a bd failure in the cascade fails soft", async () => {
  const failing: BdRunner = async () => { throw new Error("spawn bd ENOENT"); };
  const failures = await closeBackingBeads("/tmp", ["bead:ghost-1", "teams:x"], "skipped", failing);
  assert.deepEqual(failures, [{ id: "ghost-1", message: "spawn bd ENOENT" }]);
});

// RED, end to end: a cascade fault never fails the objective's own close —
// here the repo has no beads database at all, so bd cannot succeed.
test("a cascade fault never fails the objective close", async () => {
  const root = await mkdtemp(join(tmpdir(), "beads-cascade-"));
  const out: string[] = [];
  const line = (text: string) => out.push(text);
  assert.equal(await runCli(["start", "Cascade"], { cwd: root, out: line }), 0);
  assert.equal(await runCli(["ticket", "add", "Linked but unbackable", "--estimate", "15", "--ref", "bead:ghost-1"], { cwd: root, out: line }), 0);
  assert.equal(await runCli(["ticket", "done", "o1"], { cwd: root, out: line }), 0, "the close succeeds despite the bd fault");
});
