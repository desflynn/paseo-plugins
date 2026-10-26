// One JSON doc with every workspace's board on this host (o322, Des's ask
// relayed by PSR Guy). The fold is the plugin's own — readProgress builds the
// Dashboard, summariseBoard shrinks it — so the global dashboard can never
// disagree with the panel. Boards the store has no file for are skipped.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardsDocument, type WorkspaceEntry } from "./boards.ts";
import { outsideDirectory } from "./store.ts";

const RUN_START = (title: string) =>
  JSON.stringify({ v: 1, ts: "2026-10-26T21:00:00.000Z", type: "run.start", title }) + "\n";

async function worktreeWithBoard(home: string, name: string, title: string): Promise<string> {
  const root = join(home, "repos", name);
  await mkdir(root, { recursive: true });
  const store = outsideDirectory(root, home);
  await mkdir(store, { recursive: true });
  await writeFile(join(store, "progress.jsonl"), RUN_START(title), "utf8");
  return root;
}

test("boardsDocument folds every workspace with a board into one doc", async () => {
  const home = await mkdtemp(join(tmpdir(), "boards-"));
  const alpha = await worktreeWithBoard(home, "alpha", "Alpha run");
  const beta = await worktreeWithBoard(home, "beta", "Beta run");
  const bare = join(home, "repos", "bare"); // a workspace with no board at all
  await mkdir(bare, { recursive: true });

  const list = (): WorkspaceEntry[] => [
    { workspaceId: "wks_alpha", project: "alpha", name: "main", title: "Alpha workspace", cwd: alpha },
    { workspaceId: "wks_beta", project: "beta", name: "main", title: "Beta workspace", cwd: beta },
    { workspaceId: "wks_bare", project: "bare", name: "main", title: "Bare workspace", cwd: bare },
  ];

  const doc = await boardsDocument(home, list);

  assert.ok(doc.machine.length > 0, "the doc names the machine");
  assert.ok(!Number.isNaN(Date.parse(doc.at)), "the doc stamps an ISO time");
  assert.equal(doc.boards.length, 2, "a workspace with no board is skipped");

  const [first, second] = doc.boards;
  assert.equal(first.workspaceId, "wks_alpha");
  assert.equal(first.title, "Alpha workspace");
  assert.equal(first.directory, outsideDirectory(alpha, home), "the store directory is named");
  assert.ok(first.summary, "the summary fold ran");
  assert.equal(first.summary.title, "Alpha run");

  assert.equal(second.workspaceId, "wks_beta");
  assert.equal(second.summary.title, "Beta run");

  // The whole doc must serialise: it is one stdout document for the panel.
  const text = JSON.stringify(doc);
  assert.ok(JSON.parse(text).boards.length === 2, "the doc round-trips as JSON");
});

test("boardsDocument works with no boards and an unreachable workspace list", async () => {
  const home = await mkdtemp(join(tmpdir(), "boards-empty-"));
  const doc = await boardsDocument(home, () => []);
  assert.equal(doc.boards.length, 0);
  assert.equal(doc.machine.length > 0, true);
});
