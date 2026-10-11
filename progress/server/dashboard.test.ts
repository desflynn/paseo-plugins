// T6: the dashboard handler folds per workspace scope, the beads contract is
// declared, and the client query key carries scope. Seeds go through the real
// writer into a throwaway store, so the fold input is what the CLI leaves.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { Dashboard } from "../shared/dashboard.ts";
import { dashboardQueryOptions } from "../client/dashboard-query.ts";
import { handleGetAttention, handleGetDashboard } from "./dashboard.ts";
import { appendProgress } from "./progress-file.ts";
import { findRoot } from "./paths.ts";
import { findStore } from "./store.ts";

// Real store under a throwaway home; the user's own stays out of it.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const HOME = await realpath(await mkdtemp(join(tmpdir(), "progress-home-t6-")));
process.env.HOME = HOME;

const context = { paseo: {} as PluginHandlerContext["paseo"] };

async function repo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "progress-repo-t6-"));
  execFileSync("git", ["init", "-q", directory]);
  return directory;
}

// Two runs in one store, one per workspace, interleaved. Alpha also asks a
// question, so the attention pill has something of its own to count.
async function seedTwoRuns(root: string): Promise<void> {
  const store = await findStore(root);
  const add = (event: Record<string, unknown>) =>
    appendProgress(store.directory, () => new Date(), () => ({ event: event as never, result: null }));
  await add({ type: "run.start", title: "Alpha", ws: "wsA", by: "agent-a" });
  await add({ type: "ticket.add", id: "T01", title: "Alpha ticket", estimateMin: 30, ws: "wsA" });
  await add({ type: "question.ask", id: "Q01", title: "Alpha question", question: "Proceed?", ws: "wsA" });
  await add({ type: "run.start", title: "Beta", ws: "wsB", by: "agent-b" });
  await add({ type: "ticket.add", id: "T01", title: "Beta ticket", estimateMin: 45, ws: "wsB" });
}

test("workspace scope folds only that workspace's run; all folds the latest run overall", async () => {
  const root = await repo();
  await seedTwoRuns(root);
  const input = (scope: "workspace" | "all") => ({ workspaceId: "wsA", workspaceDirectory: root, scope });
  const ws = await handleGetDashboard(input("workspace"), context);
  assert.ok("dashboard" in ws);
  assert.equal(ws.dashboard.run?.title, "Alpha");
  assert.deepEqual(ws.dashboard.tickets.map((t) => t.title), ["Alpha ticket"]);
  const all = await handleGetDashboard(input("all"), context);
  assert.ok("dashboard" in all);
  assert.equal(all.dashboard.run?.title, "Beta");
  assert.deepEqual(all.dashboard.tickets.map((t) => t.title), ["Beta ticket"]);
});

test("a call with no scope defaults to this workspace", async () => {
  const root = await repo();
  await seedTwoRuns(root);
  const result = await handleGetDashboard({ workspaceId: "wsA", workspaceDirectory: root }, context);
  assert.ok("dashboard" in result);
  assert.equal(result.dashboard.run?.title, "Alpha");
});

test("switching scope is never answered unchanged", async () => {
  const root = await repo(); // nothing recorded: both scopes fold to the same empty board
  const ws = await handleGetDashboard({ workspaceId: "wsA", workspaceDirectory: root, scope: "workspace" }, context);
  const all = await handleGetDashboard({ workspaceId: "wsA", workspaceDirectory: root, scope: "all", since: ws.version }, context);
  assert.ok(!("unchanged" in all), "scope switch must not be answered with the other scope's unchanged");
});

test("same scope and version still answers unchanged, as 0.4.0 polled", async () => {
  const root = await repo();
  const first = await handleGetDashboard({ workspaceId: "wsA", workspaceDirectory: root, scope: "all" }, context);
  const second = await handleGetDashboard({ workspaceId: "wsA", workspaceDirectory: root, scope: "all", since: first.version }, context);
  assert.ok("unchanged" in second);
});

test("the attention pill counts this workspace only", async () => {
  const root = await repo();
  await seedTwoRuns(root);
  const attentionA = await handleGetAttention({ workspaceId: "wsA", workspaceDirectory: root }, context);
  assert.equal(attentionA.questions, 1);
  const attentionB = await handleGetAttention({ workspaceId: "wsB", workspaceDirectory: root }, context);
  assert.equal(attentionB.questions, 0);
});

test("the progress.beads contract is declared", async () => {
  const rpc = await import("../shared/rpc.ts");
  assert.ok("getBeads" in rpc, "shared/rpc.ts must declare the progress.beads method");
  const { getBeads, getDashboard } = rpc;
  const ok = getBeads.output.parse({ state: "ok", issues: [{ id: "bd-1", title: "Fix the thing", status: "open" }] });
  if (ok.state !== "ok") throw new Error("the ok reply carries the issues");
  assert.equal(ok.issues[0].status, "open");
  getBeads.output.parse({ state: "ok", issues: [{ id: "bd-2", title: "X", status: "closed", priority: 2, issue_type: "bug" }] });
  getBeads.output.parse({ state: "none" });
  const error = getBeads.output.parse({ state: "error", message: "bd is missing" });
  assert.equal(error.state, "error");
  assert.throws(() => getBeads.output.parse({ state: "ok", issues: [{ id: "bd-3" }] }), "id, title and status are required");
  assert.throws(() => getBeads.output.parse({ state: "error" }), "error carries a message");
  assert.throws(() => getBeads.input.parse({}), "input needs the workspace pair");
  assert.throws(() => getDashboard.input.parse({ workspaceId: "w", workspaceDirectory: "/x", scope: "bogus" }), "scope is workspace or all");
  getDashboard.input.parse({ workspaceId: "w", workspaceDirectory: "/x" });
  getDashboard.input.parse({ workspaceId: "w", workspaceDirectory: "/x", scope: "all" });
});

test("the client query key and the fetch carry scope", async () => {
  let seen: { scope?: string } | undefined;
  const fetchDashboard = (async (input: { scope?: string }) => {
    seen = input;
    return { configured: true, dashboard: {} as Dashboard, panelOpened: false, file: "", savedTo: null, inRepo: true, root: "", version: "v" };
  }) as unknown as Parameters<typeof dashboardQueryOptions>[0];
  const workspace = dashboardQueryOptions(fetchDashboard, "h", "wsA", "/dir");
  const all = dashboardQueryOptions(fetchDashboard, "h", "wsA", "/dir", undefined, "all");
  assert.deepEqual(all.queryKey, ["progress", "dashboard", "h", "wsA", "/dir", "all"]);
  assert.deepEqual(workspace.queryKey, ["progress", "dashboard", "h", "wsA", "/dir", "workspace"]);
  await all.queryFn();
  assert.equal(seen?.scope, "all");
});
