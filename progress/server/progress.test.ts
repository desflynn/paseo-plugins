// End to end: run the agent's commands in a throwaway worktree, then read the
// dashboard the panel would get.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { runCli } from "./cli.ts";
import { handleGetAttention, handleGetDashboard, handleListFolders, handleMarkPanelOpened, handleSetBoardMode, handleSetHistoryFolder } from "./dashboard.ts";
import { markPanelOpened, readProgress } from "./progress-file.ts";
import { formatEstimate, formatMinutes, formatTimeOfDay, formatWorkDone } from "../shared/format.ts";
import { boardStatuses, connDisplay, connLabel, holdHover, holdLabel, finishedToFold, headlineText, indicatorLabel, isAutoPullable, splitFinished, tickerIcon, type Dashboard, type Indicator, type Ticket } from "../shared/dashboard.ts";
import { defaultLauncherPath, installLauncher, launcherStatus } from "./launcher.ts";
import { defaultSkillPaths, installSkill, skillSource, skillStatus } from "./skill.ts";
import { MAX_PREVIEW_BYTES, MAX_PREVIEW_TEXT_BYTES, openCommand, openDeliverable, previewDeliverable } from "./open.ts";
import { attachmentIcon, canPreview, deliverableAttachment, findAttachment, imageMimeType } from "../shared/attachments.ts";
import { findStore, originIsPublic, outsideDirectory, runFileName } from "./store.ts";
import { ticketStory } from "../shared/ticket-story.ts";
import { parseWriteUp, writeUpExcerpt } from "../shared/write-up.ts";

// Real repos in these tests; the user's own git config stays out of them.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Working files live under the home folder, so each test run gets its own.
const HOME = await realpath(await mkdtemp(join(tmpdir(), "progress-home-")));
process.env.HOME = HOME;
const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })).stdout;

const o0 = Date.parse("2026-09-27T19:59:00.000Z");
const minutes = (count: number) => new Date(o0 + count * 60_000);

async function worktree(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "progress-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, "init", "-q");
  const store = outsideDirectory(directory);
  let clock = 0;
  const output: string[] = [];
  return {
    directory,
    // Where the working files are, outside the repo.
    store,
    output,
    at(minute: number) { clock = minute; },
    run(...argv: string[]) {
      return this.runAs(undefined, ...argv);
    },
    // Run as the Paseo agent with this id.
    async runAs(agentId: string | undefined, ...argv: string[]) {
      output.length = 0;
      const code = await runCli(argv, { cwd: directory, now: () => minutes(clock), out: (line) => output.push(line), agentId });
      return { code, text: output.join("\n") };
    },
    // Read at the current clock, or at a given minute.
    dashboard: (minute = clock) => readProgress(store, minutes(minute)),
  };
}

test("a line cut short by a killed command doesn't swallow the next event", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await appendFile(join(w.store, "progress.jsonl"), '{"v":1,"ts":"2026-01-01T00:00:00.000Z","type":"activity.ad');
  assert.equal((await w.run("activity", "add", "After the crash")).code, 0);
  const { dashboard } = await w.dashboard();
  assert.deepEqual(dashboard.activity.map((entry) => entry.text), ["After the crash"]);
  assert.equal(dashboard.issues.length, 1, "only the cut line is skipped");
});

test("bad values get a usage message, not a schema dump", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "Ticket 01", "--estimate", "30");
  const result = await w.run("ticket", "update", "o1", "--title", "");
  assert.equal(result.code, 1);
  assert.match(result.text, /Usage: paseo-progress ticket update/);
});

test("a ticket can't wait for one that already waits for it", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "Ticket 01", "--estimate", "30");
  await w.run("ticket", "add", "Ticket 02", "--estimate", "30", "--waits-for", "o1");
  await w.run("ticket", "add", "Ticket 03", "--estimate", "30", "--waits-for", "o2");
  const result = await w.run("ticket", "update", "o1", "--waits-for", "o3");
  assert.equal(result.code, 1);
  assert.match(result.text, /neither could start/);
});

test("a name starting with two dots is inside the worktree", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await mkdir(join(w.directory, "..notes"));
  await writeFile(join(w.directory, "..notes", "a.md"), "# A");
  await w.run("deliverable", "add", "Notes", "..notes/a.md");
  const { dashboard } = await w.dashboard();
  assert.equal(dashboard.deliverables[0].path, "..notes/a.md");
  assert.deepEqual(await previewDeliverable(w.directory, "D1"), { kind: "text", text: "# A", bytes: 3, truncated: false });
});

test("ticket update --under moves a ticket and its children under another, keeping status, stage and notes", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Sprint");
  await w.run("ticket", "add", "Heading", "--estimate", "10");
  await w.run("ticket", "add", "Other", "--estimate", "10");
  await w.run("ticket", "add", "Worker", "--estimate", "30");
  await w.run("ticket", "add", "Worker's child", "--estimate", "5", "--under", "o3");
  await w.run("ticket", "update", "o3", "--status", "in_progress", "--stage", "Build", "--note", "keep me");
  const moved = await w.run("ticket", "update", "o3", "--under", "o1");
  assert.equal(moved.code, 0, moved.text);
  assert.match(moved.text, /o3 under o1/);
  assert.match(moved.text, /id stays o3/, "the board says what happens to the old id");
  const after = (await w.dashboard()).dashboard.tickets;
  const worker = after.find((ticket) => ticket.id === "o3")!;
  assert.equal(worker.under, "o1");
  assert.equal(worker.status, "in_progress", "status survives the move");
  assert.equal(worker.stage, "Build");
  assert.equal(worker.note, "keep me");
  assert.equal(after.find((ticket) => ticket.id === "o3.1")!.under, "o3", "its children follow it");
  assert.equal((await w.run("ticket", "update", "o1", "--under", "o3")).code, 1, "never under its own child");
  assert.equal((await w.run("ticket", "update", "o1", "--under", "o3.1")).code, 1, "never under its own grandchild");
  assert.equal((await w.run("ticket", "update", "o3", "--under", "o3")).code, 1, "never under itself");
  assert.equal((await w.run("ticket", "update", "o3", "--under", "o9")).code, 1, "an unknown parent is refused");
  const lifted = await w.run("ticket", "update", "o3", "--under", "");
  assert.equal(lifted.code, 0, lifted.text);
  assert.equal((await w.dashboard()).dashboard.tickets.find((ticket) => ticket.id === "o3")!.under, undefined, "an empty --under lifts it to the top level");
  assert.match((await w.run("ticket", "update", "--help")).text, /--under/);

  // A closed ticket moves too, and keeps its status, reason and close time.
  await w.run("ticket", "update", "o2", "--status", "closed", "--close-reason", "done", "--note", "shipped");
  const before = (await w.dashboard()).dashboard.tickets.find((ticket) => ticket.id === "o2")!;
  assert.equal((await w.run("ticket", "update", "o2", "--under", "o1")).code, 0);
  const closed = (await w.dashboard()).dashboard.tickets.find((ticket) => ticket.id === "o2")!;
  assert.equal(closed.under, "o1");
  assert.equal(closed.status, "closed");
  assert.equal(closed.closeReason, "done");
  assert.equal(closed.statusSince, before.statusSince, "the close time is the close event's own, untouched by the move");
});

test("rename changes the board's title and subtitle, and nothing else", async (t) => {
  const w = await worktree(t);
  const none = await w.run("rename", "Anything");
  assert.equal(none.code, 1);
  assert.match(none.text, /No run to rename/);
  await w.run("start", "Old name", "--subtitle", "old sub");
  await w.run("ticket", "add", "Keep me", "--estimate", "10");
  await w.run("ticket", "update", "o1", "--status", "in_progress", "--note", "mid-flight");
  const before = (await w.dashboard()).dashboard.tickets[0];
  const renamed = await w.run("rename", "New name");
  assert.equal(renamed.code, 0, renamed.text);
  assert.match(renamed.text, /Renamed the board to: New name/);
  let { dashboard } = await w.dashboard();
  assert.equal(dashboard.run?.title, "New name");
  assert.equal(dashboard.run?.subtitle, "old sub", "the subtitle stays unless asked");
  assert.deepEqual(dashboard.tickets[0], before, "ids, status, notes and history are untouched");
  assert.match((await w.run("show")).text, /^Worktree: .*\n\nNew name\nold sub\n/);
  assert.equal((await w.run("rename", "--subtitle", "new sub")).code, 0, "a subtitle alone renames nothing else");
  assert.equal((await w.run("rename", "Third", "--subtitle", "")).code, 0);
  ({ dashboard } = await w.dashboard());
  assert.equal(dashboard.run?.title, "Third");
  assert.equal(dashboard.run?.subtitle, undefined, "an empty --subtitle clears it");
  assert.equal((await w.run("rename")).code, 1, "nothing to change is refused");
  await w.run("ticket", "update", "o1", "--status", "closed");
  await w.run("finish", "Done");
  assert.equal((await w.run("rename", "Archive name")).code, 0, "a finished board can be renamed");
  assert.equal((await w.dashboard()).dashboard.run?.title, "Archive name");
});

test("a write made for a workspace lands on that workspace's board, even when the unscoped latest run is finished", async (t) => {
  const w = await worktree(t);
  const as = (workspaceId: string | undefined, ...argv: string[]) => {
    const output: string[] = [];
    return runCli(argv, { cwd: w.directory, now: () => minutes(1), out: (line) => output.push(line), workspaceId }).then((code) => ({ code, text: output.join("\n") }));
  };
  assert.equal((await as("ws-a", "start", "A's run")).code, 0);
  assert.equal((await as("ws-b", "start", "Another workspace's run")).code, 0);
  assert.equal((await as("ws-b", "finish", "done")).code, 0);
  const bare = await as(undefined, "ticket", "add", "Promoted bead", "--estimate", "60", "--ref", "bead:pp-1");
  assert.equal(bare.code, 1, "unscoped, it reads the finished run");
  const scoped = await as("ws-a", "ticket", "add", "Promoted bead", "--estimate", "60", "--ref", "bead:pp-1");
  assert.equal(scoped.code, 0, scoped.text);
  const { dashboard } = await readProgress(w.store, minutes(1), "ws-a");
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.title), ["Promoted bead"], "it shows in the workspace's own Objectives");
});

test("start only creates a board; over an existing one it refuses and drops nothing", async (t) => {
  const w = await worktree(t);
  const first = await w.run("start", "First board");
  assert.equal(first.code, 0, "a workspace with no board can start one");
  await w.run("ticket", "add", "Open watch", "--estimate", "10");
  await w.run("ticket", "add", "Another", "--estimate", "10");
  const refused = await w.run("start", "New theme");
  assert.equal(refused.code, 1);
  assert.match(refused.text, /already has a board: "First board"/, "it names the current board");
  assert.match(refused.text, /paseo-progress show/);
  assert.match(refused.text, /paseo-progress rename/);
  assert.match(refused.text, /--replace/);
  const after = (await w.dashboard()).dashboard;
  assert.equal(after.run?.title, "First board", "the board is untouched");
  assert.deepEqual(after.tickets.map((ticket) => ticket.title), ["Open watch", "Another"], "its open tickets are still there");
  const loud = await w.run("start", "Replacement", "--replace");
  assert.equal(loud.code, 0, loud.text);
  assert.match(loud.text, /Replaced the board "First board": 2 open objectives leave the dashboard/, "the override says what it drops");
  assert.equal((await w.dashboard()).dashboard.run?.title, "Replacement");
  // A finished board refuses too, with nothing to drop.
  await w.run("finish", "Done");
  const afterFinish = await w.run("start", "Again");
  assert.equal(afterFinish.code, 1);
  assert.match(afterFinish.text, /already has a board: "Replacement"/);
});

test("a write with no agent id to a finished run says the id is missing", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Export");
  await w.run("finish", "Shipped");
  const bare = await w.runAs(undefined, "ticket", "add", "More", "--estimate", "10");
  assert.equal(bare.code, 1);
  assert.match(bare.text, /is finished\. Start new work with: paseo-progress start/);
  assert.match(bare.text, /No PASEO_AGENT_ID reached this command/, "an agent shell that lost its id is told why it sees the closed run");
  const seated = await w.runAs("agent-without-record", "ticket", "add", "More", "--estimate", "10");
  assert.equal(seated.code, 1);
  assert.doesNotMatch(seated.text, /PASEO_AGENT_ID/, "a call that carried an id gets no hint");
});

test("finish closes the run only once everything is settled, and keeps it on the dashboard", async (t) => {
  const w = await worktree(t);
  assert.equal((await w.run("finish", "Nothing yet")).code, 1, "no run to finish");
  await w.run("start", "Export");
  await w.run("ticket", "add", "Ticket 01", "--estimate", "30");
  await w.run("question", "ask", "Format", "CSV or JSON?", "--recommend", "CSV");
  await w.run("stuck", "set", "Staging is down");
  const refused = await w.run("finish", "Shipped");
  assert.equal(refused.code, 1);
  assert.match(refused.text, /Can't finish yet\. Still open: open questions Q1 .*; objectives not done or skipped: o1; flagged blockers S1/);

  await w.run("question", "answer", "Q1", "CSV");
  await w.run("ticket", "update", "o1", "--status", "done");
  await w.run("stuck", "clear", "S1");
  await w.run("ticker", "set", "Wrapping up");
  assert.deepEqual(await w.run("finish", "Shipped the CSV export"), { code: 0, text: "Finished run: Export" });

  w.at(120);
  const { dashboard } = await w.dashboard();
  assert.equal(dashboard.run?.title, "Export", "the finished run stays on the dashboard");
  assert.equal(dashboard.run?.finished?.outcome, "Shipped the CSV export");
  assert.equal(dashboard.ticker, null);
  assert.equal(dashboard.stale, false);
  assert.match((await w.run("show")).text, /Finished .*: Shipped the CSV export\nThis run is closed/);

  const after = await w.run("ticket", "add", "Ticket 02", "--estimate", "10");
  assert.equal(after.code, 1);
  assert.match(after.text, /The run "Export" is finished\. Start new work with: paseo-progress start/);
  assert.equal((await w.run("start", "Next job", "--replace")).code, 0);
  assert.equal((await w.dashboard()).dashboard.run?.finished, undefined, "a new run starts open");
});

test("a ticket's story: its stages with durations, and what belongs to it exactly or by time", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Export");
  await w.run("ticket", "add", "Ticket 01: CSV", "--estimate", "30");
  await w.run("ticket", "add", "Ticket 02: JSON", "--estimate", "30");
  await w.run("activity", "add", "Run-wide kickoff");
  w.at(10);
  await w.run("ticket", "update", "o1", "--status", "working", "--stage", "Build");
  w.at(15);
  await w.run("activity", "add", "Untagged, while o1 worked");
  assert.match((await w.run("activity", "add", "Tagged to o1", "--ticket", "t01")).text, /^Logged A3 on o1: /);
  await w.run("question", "ask", "Delimiter", "Comma or tab?", "--recommend", "Comma", "--ticket", "o1");
  await w.run("deliverable", "add", "Sample", "https://example.com/sample.csv", "--ticket", "o1");
  assert.equal((await w.run("activity", "add", "Bad tag", "--ticket", "o9")).code, 1, "an unknown ticket is refused");
  w.at(25);
  await w.run("ticket", "update", "o1", "--stage", "Review", "--note", "Build went fast");
  w.at(40);
  await w.run("ticket", "update", "o1", "--status", "done");
  await w.run("ticket", "update", "o2", "--status", "working");
  await w.run("activity", "add", "Tagged to o1 later", "--ticket", "o1");
  await w.run("activity", "add", "Untagged, while o2 worked");

  const { dashboard } = await w.dashboard(50);
  const t01 = dashboard.tickets.find((ticket) => ticket.id === "o1")!;
  const story = ticketStory(t01, {
    deliverables: dashboard.deliverables,
    questions: [...dashboard.questions.open, ...dashboard.questions.answered],
    activity: [...dashboard.activity].reverse(),
  }, minutes(50).getTime());
  assert.deepEqual(story.timeline.map((step) => [step.label, step.minutes === null ? null : Math.round(step.minutes)]), [
    ["Added", 10], ["Build stage", 15], ["Review stage", 15], ["Done", null],
  ]);
  assert.deepEqual(story.timeline[2].notes, ["Build went fast"]);
  assert.equal(Math.round(story.workedMin), 30);
  assert.deepEqual(story.activity.map((entry) => [entry.text, entry.link]), [
    ["Untagged, while o1 worked", "by-time"],
    ["Tagged to o1", "tagged"],
    ["Tagged to o1 later", "tagged"],
  ]);
  assert.deepEqual(story.questions.map((question) => [question.id, question.link]), [["Q1", "tagged"]]);
  assert.deepEqual(story.deliverables.map((deliverable) => deliverable.id), ["D1"]);

  const t02 = dashboard.tickets.find((ticket) => ticket.id === "o2")!;
  const current = ticketStory(t02, { deliverables: [], questions: [], activity: [...dashboard.activity].reverse() }, minutes(50).getTime());
  assert.deepEqual(current.timeline.map((step) => [step.label, Math.round(step.minutes!)]), [["Added", 40], ["Working", 10]], "the step still going runs to now");
  assert.deepEqual(current.activity.map((entry) => entry.text), ["Untagged, while o2 worked"], "tags to another ticket never match by time");
});

test("a ticket waiting for another is not stuck, even if marked blocked, until that one is done", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Release");
  await w.run("ticket", "add", "Ticket 01: Build", "--estimate", "30");
  assert.match((await w.run("ticket", "add", "Ship", "--estimate", "10", "--waits-for", "t01")).text, /waits for o1$/);
  await w.run("ticket", "add", "Docs", "--estimate", "10");
  assert.equal((await w.run("ticket", "update", "o2", "--waits-for", "o2")).code, 1, "can't wait for itself");
  assert.equal((await w.run("ticket", "update", "o3", "--waits-for", "o9")).code, 1, "must name a ticket in the run");
  await w.run("ticket", "update", "o2", "--status", "blocked", "--note", "Waits on Ticket 01");
  await w.run("ticket", "update", "o3", "--status", "blocked", "--note", "Staging is down");

  let { dashboard } = await w.dashboard();
  assert.deepEqual(dashboard.tickets.find((ticket) => ticket.id === "o2")?.waitingFor, { id: "o1", title: "Ticket 01: Build" });
  assert.deepEqual(dashboard.stuck.map((item) => item.key), ["blocked:o3"], "only the outside blocker is stuck");
  assert.equal(dashboard.progress.segments.find((segment) => segment.id === "o2")?.waiting, true);
  assert.match((await w.run("show")).text, /o2 {2}Waiting for o1/);

  await w.run("ticket", "update", "o1", "--status", "done");
  ({ dashboard } = await w.dashboard());
  assert.equal(dashboard.tickets.find((ticket) => ticket.id === "o2")?.waitingFor, undefined, "done unblocks the wait");
  assert.deepEqual(dashboard.stuck.map((item) => item.key), ["blocked:o2", "blocked:o3"], "still marked blocked after it: now that's stuck");
  await w.run("ticket", "update", "o2", "--waits-for", "");
  assert.equal((await w.dashboard()).dashboard.tickets.find((ticket) => ticket.id === "o2")?.waitsFor, undefined, "an empty value clears it");
});

test("opening the panel is remembered in the worktree", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Export");
  assert.equal((await w.dashboard()).panelOpened, false);
  await markPanelOpened(w.store);
  assert.equal((await w.dashboard()).panelOpened, true);
  await w.run("start", "Another run", "--replace");
  assert.equal((await w.dashboard()).panelOpened, true, "a new run doesn't bring the pill back");
});

test("a worktree without a progress file reads as not configured", async (t) => {
  const w = await worktree(t);
  const result = await w.dashboard();
  assert.equal(result.configured, false);
  assert.deepEqual(result.dashboard.tickets, []);
});

test("tickets added and updated by the agent show up with ids, statuses, and the headline", async (t) => {
  const w = await worktree(t);
  assert.deepEqual(await w.run("start", "Loan Options", "--subtitle", "Frozen links"), { code: 0, text: "Started run: Loan Options" });
  assert.equal((await w.run("ticket", "add", "Ticket 01: Saved table", "--estimate", "120")).text, "Added o1: Ticket 01: Saved table (120 min)");
  await w.run("ticket", "add", "Ticket 02: Copy Link", "--estimate", "150");
  await w.run("ticket", "add", "Ticket 03: Frozen links", "--estimate", "120");
  await w.run("ticket", "add", "Ticket 04: Time zones", "--estimate", "75");
  w.at(30);
  await w.run("ticket", "update", "t01", "--status", "done");
  await w.run("ticket", "update", "o2", "--status", "done");
  assert.equal((await w.run("ticket", "update", "o3", "--status", "working", "--note", "Fixes after review")).code, 0);

  const { configured, dashboard } = await w.dashboard();
  assert.equal(configured, true);
  assert.deepEqual(dashboard.run, { title: "Loan Options", subtitle: "Frozen links", itemLabel: "Objective", startedAt: minutes(0).toISOString() });
  assert.equal(headlineText(dashboard), "2 of 4 objectives done");
  assert.equal(dashboard.updatedAt, minutes(30).toISOString());
  assert.deepEqual(
    dashboard.tickets.map(({ id, status, estimateMin }) => [id, status, estimateMin]),
    [["o1", "closed", 120], ["o2", "closed", 150], ["o3", "in_progress", 120], ["o4", "open", 75]],
  );
  assert.equal(dashboard.tickets[2].note, "Fixes after review");
  assert.deepEqual(dashboard.issues, []);
});

test("the panel folds every finished ticket, and only two or more", () => {
  const list = (...statuses: Ticket["status"][]) => statuses.map((status, index) => ({ id: `o${index + 1}`, title: "", estimateMin: 10, status, statusSince: "", history: [] }));
  const folded = (...statuses: Ticket["status"][]) => finishedToFold(list(...statuses)).map((ticket) => ticket.id);
  assert.deepEqual(folded("closed", "closed", "closed", "in_progress", "closed", "open"), ["o1", "o2", "o3", "o5"], "the done ticket after the working one folds too");
  assert.deepEqual(folded("open", "closed", "closed"), ["o2", "o3"]);
  assert.deepEqual(folded("closed", "in_progress", "open"), [], "one finished ticket isn't worth a fold row");
  assert.deepEqual(folded("closed", "closed", "closed"), [], "once everything is finished, the whole list shows");
  assert.deepEqual(folded(), []);
});

test("the objectives list keeps every finished ticket the fold doesn't take", () => {
  const list = (...statuses: Ticket["status"][]) => statuses.map((status, index) => ({ id: `o${index + 1}`, title: "", estimateMin: 10, status, statusSince: "", history: [] }));
  const split = (...statuses: Ticket["status"][]) => {
    const { listed, folded } = splitFinished(list(...statuses));
    return [listed.map((ticket) => ticket.id), folded.map((ticket) => ticket.id)];
  };
  assert.deepEqual(split("closed", "closed", "closed"), [["o1", "o2", "o3"], []], "an all-done board still lists its objectives");
  assert.deepEqual(split("closed", "in_progress", "open"), [["o1", "o2", "o3"], []], "a lone finished objective stays in place");
  assert.deepEqual(split("open", "closed", "closed"), [["o1"], ["o2", "o3"]], "two or more finished fold behind the count row");
  assert.deepEqual(split(), [[], []]);
});

test("the board status shows idle, active, stale and stuck, at most two together", () => {
  // Stuck items point at a P1 objective (o1); the Stuck rule lives in its own test below.
  const board = (statuses: Ticket["status"][], stuck: number, stale: boolean, conn = false) => ({
    tickets: statuses.map((status, index) => ({ id: `o${index + 1}`, title: "", estimateMin: 10, status, priority: 1, statusSince: "", history: [] })) as Ticket[],
    stuck: Array.from({ length: stuck }, () => ({ kind: "blocked", ticketId: "o1" })) as unknown as Dashboard["stuck"],
    stale,
    ...(conn ? { conn: { on: true } } : {}),
  });
  const status = (b: ReturnType<typeof board>, agentRunning = false) => boardStatuses(b, agentRunning);
  assert.deepEqual(status(board([], 0, false)), [{ kind: "idle" }]);
  assert.deepEqual(status(board(["open", "closed"], 0, true)), [{ kind: "idle" }], "queued work that sat quiet is idle, never stale");
  assert.deepEqual(status(board(["in_progress", "in_progress", "open"], 0, false)), [{ kind: "active", count: 2 }]);
  assert.deepEqual(status(board(["in_progress", "in_progress"], 0, true)), [{ kind: "stale", count: 2 }]);
  assert.deepEqual(status(board(["in_progress"], 0, true), true), [{ kind: "active", count: 1 }], "a running agent keeps quiet work active");
  assert.deepEqual(status(board(["open"], 3, false)), [{ kind: "idle" }], "nothing running and no full auto: a blocker is not stuck");
  assert.deepEqual(status(board(["open"], 3, false, true)), [{ kind: "stuck", count: 3 }], "on full auto, stuck alone replaces idle");
  assert.deepEqual(status(board(["in_progress"], 1, false)), [{ kind: "active", count: 1 }, { kind: "stuck", count: 1 }]);
  assert.deepEqual(status(board(["in_progress"], 2, true)), [{ kind: "stale", count: 1 }, { kind: "stuck", count: 2 }]);
});

test("removed tickets leave the dashboard and their ids are never reused", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "One", "--estimate", "10");
  await w.run("ticket", "add", "Two", "--estimate", "10");
  assert.equal((await w.run("ticket", "remove", "o2")).text, "Removed o2: Two");
  assert.match((await w.run("ticket", "add", "Three", "--estimate", "10")).text, /^Added o3/);
  await w.run("ticket", "update", "o3", "--status", "skipped");
  const { dashboard } = await w.dashboard();
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.id), ["o1", "o3"]);
  assert.equal(headlineText(dashboard), "0 of 1 objective done", "skipped tickets are not counted");
});

test("bad input fails with a clear message and writes nothing", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "One", "--estimate", "10");
  const before = await readFile(join(w.store, "progress.jsonl"), "utf8");
  const cases: Array<[string[], RegExp]> = [
    [["ticket", "add", "--estimate", "10"], /Missing ticket title/],
    [["ticket", "add", "Two"], /Missing --estimate/],
    [["ticket", "add", "Two", "--estimate", "ninety"], /whole number of minutes/],
    [["ticket", "update", "o1", "--status", "finished"], /--status must be one of: open, in_progress, blocked, closed/],
    [["ticket", "update", "o9", "--status", "done"], /No ticket o9 in this run\. Tickets: o1/],
    [["ticket", "update", "o1"], /Nothing to change/],
    [["ticket", "add", "Two", "--estimate", "10", "--colour", "red"], /Unknown option '--colour'/],
    [["tickets", "add"], /Unknown command: tickets add/],
  ];
  for (const [argv, message] of cases) {
    const result = await w.run(...argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.text, message);
  }
  assert.equal(await readFile(join(w.store, "progress.jsonl"), "utf8"), before);
});

test("commands find the worktree root from a subdirectory", async (t) => {
  const w = await worktree(t);
  const nested = join(w.directory, "packages", "app");
  await mkdir(nested, { recursive: true });
  assert.equal(await runCli(["start", "From below"], { cwd: nested, out: () => {} }), 0);
  assert.equal((await w.dashboard()).dashboard.run?.title, "From below");
});

// A Paseo project registered at a subfolder of the repo: the workspace
// directory is <worktree>/apps/client, but the agent writes at the root.
test("a workspace below the worktree root reads the root's progress and attachments", async (t) => {
  const w = await worktree(t);
  const workspace = join(w.directory, "apps", "client");
  await mkdir(join(w.directory, "reports"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(w.directory, "reports", "review.md"), "# A");
  const run = (...argv: string[]) => runCli(argv, { cwd: workspace, now: () => minutes(0), out: () => {} });
  assert.equal(await run("start", "From the app"), 0);
  assert.equal(await run("deliverable", "add", "Review", "../../reports/review.md"), 0);
  assert.equal(await run("question", "ask", "Pick", "Which?", "--option", "A=One", "--option", "B=Two", "--recommend", "A"), 0);
  const context = { paseo: {} as PluginHandlerContext["paseo"] };
  const input = { workspaceId: "ws-1", workspaceDirectory: workspace };

  const result = await handleGetDashboard(input, context);
  assert.ok("dashboard" in result);
  assert.equal(result.dashboard.run?.title, "From the app");
  assert.equal(result.root, w.directory, "the panel resolves stored paths against the worktree root");
  assert.equal((await handleGetAttention(input, context)).questions, 1);
  await handleMarkPanelOpened(input, context);
  assert.equal((await handleGetAttention(input, context)).panelOpened, true);
  assert.deepEqual(await previewDeliverable(workspace, "D1"), { kind: "text", text: "# A", bytes: 3, truncated: false });
});

test("the handler reads the requested workspace directory without calling Paseo", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  const paseo = new Proxy({} as PluginHandlerContext["paseo"], { get() { throw new Error("must not call paseo"); } });
  const result = await handleGetDashboard({ workspaceId: "ws-1", workspaceDirectory: w.directory }, { paseo });
  assert.ok("dashboard" in result);
  assert.equal(result.dashboard.run?.title, "Run");
});

test("a poll with the current version gets a short unchanged reply until the file changes", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  const context = { paseo: {} as PluginHandlerContext["paseo"] };
  const input = { workspaceId: "ws-1", workspaceDirectory: w.directory };
  const first = await handleGetDashboard(input, context);
  assert.ok("dashboard" in first);
  assert.deepEqual(await handleGetDashboard({ ...input, since: first.version }, context), { unchanged: true, version: first.version });
  await w.run("ticket", "add", "Ticket 01: Next", "--estimate", "10");
  const second = await handleGetDashboard({ ...input, since: first.version }, context);
  assert.ok("dashboard" in second, "a change to the file sends the new dashboard");
  assert.equal(second.dashboard.tickets.length, 1);
  assert.notEqual(second.version, first.version);
});

test("the pill check returns only counts and run state", async (t) => {
  const w = await worktree(t);
  const context = { paseo: {} as PluginHandlerContext["paseo"] };
  const input = { workspaceId: "ws-1", workspaceDirectory: w.directory };
  assert.deepEqual(await handleGetAttention(input, context), { configured: false, questions: 0, stuck: 0, runOpen: false, panelOpened: false });
  await w.run("start", "Run");
  await w.run("question", "ask", "Spacing", "Tighter?", "--option", "A=Yes | tighter", "--option", "B=No | as is", "--recommend", "A");
  assert.deepEqual(await handleGetAttention(input, context), { configured: true, questions: 1, stuck: 0, runOpen: true, panelOpened: false });
});

test("unchanged dashboards are reused until exact stale and overdue boundaries, including clock rollback", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "Work", "--estimate", "20", "--status", "working");
  const first = (await w.dashboard(0)).dashboard;
  assert.strictEqual((await w.dashboard(14)).dashboard, first, "ordinary polls reuse the reduction");
  const stale = (await w.dashboard(15)).dashboard;
  assert.notStrictEqual(stale, first);
  assert.equal(stale.stale, true);
  assert.equal(first.stale, false, "cached snapshots are never mutated");
  assert.strictEqual((await w.dashboard(20)).dashboard, stale, "exactly at the estimate is not overdue");
  const overdue = (await readProgress(w.store, new Date(minutes(20).getTime() + 1))).dashboard;
  assert.equal(overdue.stuck.length, 1);
  assert.equal(overdue.stuck[0].kind, "overdue");
  assert.strictEqual((await w.dashboard(60)).dashboard, overdue, "no further time changes remain");
  const rewound = (await w.dashboard(1)).dashboard;
  assert.equal(rewound.stale, false);
  assert.deepEqual(rewound.stuck, []);
});

test("each working ticket's overdue moment ends the cached dashboard", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "Short", "--estimate", "5", "--status", "working");
  await w.run("ticket", "add", "Long", "--estimate", "10", "--status", "working");
  const after = (minute: number) => readProgress(w.store, new Date(minutes(minute).getTime() + 1));
  const first = (await w.dashboard(0)).dashboard;
  assert.strictEqual((await w.dashboard(5)).dashboard, first);
  const one = (await after(5)).dashboard;
  assert.deepEqual(one.stuck.map((item) => item.ticketId), ["o1"]);
  assert.strictEqual((await w.dashboard(10)).dashboard, one);
  const both = (await after(10)).dashboard;
  assert.deepEqual(both.stuck.map((item) => item.ticketId), ["o1", "o2"]);
});

test("rewriting or deleting the file invalidates the reduced dashboard", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run A");
  const first = (await w.dashboard()).dashboard;
  const path = join(w.store, "progress.jsonl");
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace("Run A", "Run B"));
  const changed = (await w.dashboard()).dashboard;
  assert.notStrictEqual(changed, first);
  assert.equal(changed.run?.title, "Run B");
  await rm(path);
  assert.equal((await w.dashboard()).configured, false);
  await writeFile(path, text);
  assert.equal((await w.dashboard()).dashboard.run?.title, "Run A");
});

test("opening the panel changes the response version without rebuilding the dashboard", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  const context = { paseo: {} as PluginHandlerContext["paseo"] };
  const input = { workspaceId: "ws-1", workspaceDirectory: w.directory };
  const first = await handleGetDashboard(input, context);
  assert.ok("dashboard" in first);
  await markPanelOpened(w.store);
  const opened = await handleGetDashboard({ ...input, since: first.version }, context);
  assert.ok("dashboard" in opened);
  assert.strictEqual(opened.dashboard, first.dashboard);
  assert.equal(opened.panelOpened, true);
  assert.notEqual(opened.version, first.version);
  assert.deepEqual(await handleGetDashboard({ ...input, since: opened.version }, context), { unchanged: true, version: opened.version });
});

test("the command runs as a script and stamps the real time", async (t) => {
  const w = await worktree(t);
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const before = Date.now();
  const { stdout } = await promisify(execFile)(process.execPath, [cli, "start", "Real clock"], { cwd: w.directory });
  assert.equal(stdout.trim(), "Started run: Real clock");
  const updatedAt = Date.parse((await w.dashboard()).dashboard.updatedAt ?? "");
  assert.ok(updatedAt >= before - 1000 && updatedAt <= Date.now() + 1000);
});

test("each event records the Paseo agent that wrote it, from PASEO_AGENT_ID", async (t) => {
  const w = await worktree(t);
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const run = (env: NodeJS.ProcessEnv, ...argv: string[]) => promisify(execFile)(process.execPath, [cli, ...argv], { cwd: w.directory, env });
  const { PASEO_AGENT_ID: _, ...outside } = process.env;
  await run({ ...process.env, PASEO_AGENT_ID: "agent-a" }, "start", "Run");
  await run(outside, "ticker", "set", "From a terminal");
  const lines = (await readFile(join(w.store, "progress.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.by), ["agent-a", undefined]);
});

test("an agent hears about tickets another session added, once, on its next command", async (t) => {
  const w = await worktree(t);
  await w.runAs("a", "start", "Run");
  await w.runAs("a", "ticket", "add", "Ticket 01: Mine", "--estimate", "30");
  assert.doesNotMatch((await w.runAs("a", "ticket", "update", "o1", "--status", "working")).text, /Another session/, "its own tickets are not news");

  await w.runAs("b", "ticket", "add", "Ticket 02: Theirs", "--estimate", "20");
  await w.run("ticket", "add", "Ticket 03: From a terminal", "--estimate", "20");
  await w.runAs("b", "ticket", "add", "Ticket 04: Already done", "--estimate", "20", "--status", "done");
  await w.runAs("b", "ticket", "add", "Ticket 05: Removed again", "--estimate", "20");
  await w.runAs("b", "ticket", "remove", "o5");

  const shown = await w.runAs("a", "show");
  assert.match(shown.text, /Another session added 2 objectives since your last update:\n  o2  Ticket 02: Theirs\n  o3  Ticket 03: From a terminal\nThey are not an order: take them only if your task names them\.$/);
  const told = await w.runAs("a", "ticker", "set", "Building");
  assert.equal(told.text, "Ticker: Building\n\nAnother session added 2 objectives since your last update:\n  o2  Ticket 02: Theirs\n  o3  Ticket 03: From a terminal\nThey are not an order: take them only if your task names them.");
  assert.equal((await w.runAs("a", "ticker", "set", "Still building")).text, "Ticker: Still building", "each alert shows once");

  await w.runAs("b", "ticket", "add", "Ticket 06: One more", "--estimate", "20");
  assert.match((await w.runAs("a", "ticket", "update", "o1", "--stage", "Review")).text, /added an objective since your last update:\n  o6  Ticket 06: One more\nIt is not an order: take it only if your task names it\.$/);
});

test("an agent new to the run, a command outside Paseo, and a new run hear nothing", async (t) => {
  const w = await worktree(t);
  await w.runAs("a", "start", "Run", "--item-label", "Step");
  await w.runAs("a", "ticket", "add", "First", "--estimate", "30");
  assert.doesNotMatch((await w.runAs("b", "ticker", "set", "Joining")).text, /Another session/, "b reads show first");
  assert.doesNotMatch((await w.runAs("b", "show")).text, /Another session/);
  await w.runAs("b", "ticket", "add", "Second", "--estimate", "30");
  assert.doesNotMatch((await w.run("ticker", "set", "From a terminal")).text, /Another session/);
  assert.doesNotMatch((await w.runAs("a", "start", "Next run", "--item-label", "Step", "--replace")).text, /Another session/);
  await w.runAs("b", "ticket", "add", "Third", "--estimate", "30");
  assert.match((await w.runAs("a", "ticker", "set", "Back")).text, /Another session added a step since your last update:\n  o1  Third\nIt is not an order: take it only if your task names it\.$/);
});

test("a ticket links to where it's written up: a file in the worktree or a link, changed or cleared later", async (t) => {
  const w = await worktree(t);
  await mkdir(join(w.directory, "specs"));
  await writeFile(join(w.directory, "specs", "01-login.md"), "# Login\n");
  await w.run("start", "Run");
  assert.equal((await w.run("ticket", "add", "Ticket 01: Login", "--estimate", "30", "--source", "specs/01-login.md")).text, "Added o1: Ticket 01: Login (30 min), source specs/01-login.md");
  await w.run("ticket", "add", "Ticket 02: Reset", "--estimate", "20", "--source", "https://linear.app/acme/issue/ENG-12=ENG-12");
  await w.run("ticket", "add", "Ticket 03: No write-up", "--estimate", "20");
  let { dashboard } = await w.dashboard();
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.source), [{ path: "specs/01-login.md" }, { url: "https://linear.app/acme/issue/ENG-12", label: "ENG-12" }, undefined]);
  assert.deepEqual(findAttachment(dashboard, "o1.source"), { ref: "o1.source", title: "01-login.md", path: "specs/01-login.md", url: undefined });
  assert.equal(findAttachment(dashboard, "o3.source"), null);
  assert.match((await w.run("show")).text, /o1 .*Ticket 01: Login\n      Source: specs\/01-login.md\n.*o2 .*\n      Source: https:\/\/linear.app\/acme\/issue\/ENG-12 \(ENG-12\)\n.*o3 .*No write-up(\n|$)/);

  assert.deepEqual(await previewDeliverable(w.directory, "o1.source"), { kind: "text", text: "# Login\n", bytes: 8, truncated: false });

  assert.equal((await w.run("ticket", "update", "o3", "--source", "specs/01-login.md=Shared spec")).text, "Updated o3: source specs/01-login.md");
  await w.run("ticket", "update", "o2", "--source", "");
  ({ dashboard } = await w.dashboard());
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.source), [{ path: "specs/01-login.md" }, undefined, { path: "specs/01-login.md", label: "Shared spec" }]);
});

test("a write-up reads as headings, paragraphs, list items and code, and its excerpt drops the title", () => {
  const blocks = parseWriteUp([
    "# Ticket 01: Login",
    "",
    "Let people sign in with **email** and a [magic link](https://x.y).",
    "It wraps onto",
    "two lines.",
    "",
    "## Acceptance",
    "- [ ] Sends the `link`",
    "  within a minute",
    "  1. Nested _step_",
    "---",
    "```",
    "npm test",
    "```",
  ].join("\n"));
  assert.deepEqual(blocks, [
    { kind: "heading", level: 1, spans: [{ text: "Ticket 01: Login" }] },
    { kind: "paragraph", spans: [{ text: "Let people sign in with email and a magic link. It wraps onto two lines." }] },
    { kind: "heading", level: 2, spans: [{ text: "Acceptance" }] },
    { kind: "item", marker: "☐", depth: 0, spans: [{ text: "Sends the " }, { text: "link", code: true }, { text: " within a minute" }] },
    { kind: "item", marker: "1.", depth: 1, spans: [{ text: "Nested step" }] },
    { kind: "code", text: "npm test" },
  ]);
  const short = writeUpExcerpt(blocks, 90);
  assert.equal(short.blocks[0].kind, "paragraph", "the title is the ticket's own, so it's left out");
  assert.equal(short.blocks.length, 2);
  assert.equal(short.more, true);
  assert.equal(writeUpExcerpt(blocks).more, false);
});

test("each ticket and the ticker remember the agent that last wrote them", async (t) => {
  const w = await worktree(t);
  await w.runAs("a", "start", "Run");
  await w.runAs("a", "ticket", "add", "One", "--estimate", "30");
  await w.run("ticket", "add", "Two", "--estimate", "30");
  await w.runAs("b", "ticket", "update", "o1", "--status", "working");
  await w.run("ticket", "update", "o1", "--stage", "Review");
  await w.runAs("b", "ticker", "set", "Reviewing");
  const { dashboard } = await w.dashboard();
  assert.deepEqual(dashboard.tickets.map((ticket) => ticket.agentId), ["b", undefined]);
  assert.equal(dashboard.ticker?.by, "b");
});

test("plain steps, with no write-ups, stages or Paseo agent, still get a dialog with a time bar and nothing missing", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Clean up the garage", "--item-label", "Step");
  await w.run("ticket", "add", "Sort the shelves", "--estimate", "30");
  await w.run("ticket", "update", "o1", "--status", "working");
  await w.run("ticker", "set", "Sorting tools");
  w.at(12);
  const { dashboard } = await w.dashboard();
  const [step] = dashboard.tickets;
  assert.equal(step.source, undefined, "no write-up section");
  assert.equal(step.agentId, undefined, "no agent row");
  assert.equal(dashboard.ticker?.by, undefined, "the status line goes by the one working step");
  assert.deepEqual(ticketStory(step, { deliverables: [], questions: [], activity: [] }, minutes(12).getTime()).timeline.map(({ label, minutes }) => ({ label, minutes })),
    [{ label: "Added", minutes: 0 }, { label: "Working", minutes: 12 }], "one working span for the time bar");
});

async function screenshotRun(t: TestContext) {
  const w = await worktree(t);
  await w.run("start", "Loan Options");
  await w.run("ticket", "add", "Ticket 01", "--estimate", "120");
  await w.run("ticket", "add", "Ticket 02", "--estimate", "150");
  await w.run("ticket", "add", "Ticket 03", "--estimate", "120");
  await w.run("ticket", "add", "Ticket 04", "--estimate", "75");
  await w.run("ticket", "update", "o1", "--status", "done");
  await w.run("ticket", "update", "o2", "--status", "done");
  await w.run("ticket", "update", "o3", "--status", "working");
  return w;
}

test("progress matches the reference dashboard: 58%, 4 h 30 min of 7 h 45 min", async (t) => {
  const w = await screenshotRun(t);
  const { progress } = (await w.dashboard()).dashboard;
  assert.equal(progress.percent, 58);
  assert.equal(formatWorkDone(progress.doneMin, progress.totalMin), "4 h 30 min of 7 h 45 min");
  assert.deepEqual(
    progress.segments.map(({ id, estimateMin, status }) => `${id}:${estimateMin}:${status}`),
    ["o1:120:closed", "o2:150:closed", "o3:120:in_progress", "o4:75:open"],
  );
});

test("skipped tickets leave the progress bar and the totals", async (t) => {
  const w = await screenshotRun(t);
  await w.run("ticket", "update", "o4", "--status", "skipped");
  const { progress } = (await w.dashboard()).dashboard;
  assert.equal(progress.totalMin, 390);
  assert.equal(progress.percent, 69);
  assert.deepEqual(progress.segments.map((segment) => segment.id), ["o1", "o2", "o3"]);
});

test("the dashboard turns stale exactly 15 minutes after the last event", async (t) => {
  const w = await screenshotRun(t);
  w.at(10);
  await w.run("ticket", "update", "o3", "--note", "Still going");
  assert.equal((await w.dashboard(24)).dashboard.stale, false);
  assert.equal((await w.dashboard(25)).dashboard.stale, true);
  w.at(26);
  await w.run("ticket", "update", "o3", "--note", "Back");
  assert.equal((await w.dashboard(26)).dashboard.stale, false, "a new event clears it");
});

test("once every ticket is done, the dashboard says how long the run really took", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "One", "--estimate", "30");
  await w.run("ticket", "add", "Two", "--estimate", "30");
  await w.run("ticket", "add", "Extra", "--estimate", "30");
  w.at(40);
  await w.run("ticket", "update", "o1", "--status", "done");
  assert.equal((await w.dashboard()).dashboard.progress.tookMin, undefined, "not while work remains");
  w.at(70);
  await w.run("ticket", "update", "o2", "--status", "done");
  w.at(85);
  await w.run("ticket", "update", "o3", "--status", "skipped");
  const { progress } = (await w.dashboard(200)).dashboard;
  assert.equal(progress.tookMin, 85, "from the start to the last ticket settling, not to now");
  assert.match((await w.run("show")).text, /100% of estimated work done, took 1 h 25 min/);
});

test("a run whose tickets are all done or skipped never turns stale", async (t) => {
  const w = await screenshotRun(t);
  w.at(10);
  for (const id of ["o1", "o2", "o3"]) await w.run("ticket", "update", id, "--status", "done");
  await w.run("ticket", "update", "o4", "--status", "skipped");
  assert.equal((await w.dashboard(60)).dashboard.stale, false);
});

test("display helpers format durations and hours the way the panel shows them", () => {
  const morning = new Date(2026, 9, 5, 2, 8).toISOString();
  assert.equal(formatTimeOfDay(morning, new Date(2026, 9, 5, 23, 0).getTime()), "2:08 AM", "same day: just the time");
  assert.equal(formatTimeOfDay(morning, new Date(2026, 9, 6, 9, 0).getTime()), "Oct 5, 2:08 AM", "another day: the date too");
  assert.equal(formatMinutes(0.5), "<1 min");
  assert.equal(formatMinutes(12), "12 min");
  assert.equal(formatMinutes(602), "10 h 2 min");
  assert.equal(formatMinutes(120), "2 h");
  assert.equal(formatEstimate(45), "45 min", "estimates under an hour stay in minutes");
  assert.equal(formatEstimate(60), "1 h");
  assert.equal(formatEstimate(66), "1.1 h");
  assert.equal(formatEstimate(90), "1.5 h");
  assert.equal(formatEstimate(150), "2.5 h");
  assert.equal(formatWorkDone(10, 10), "10 of 10 min", "under an hour, the unit is said once");
  assert.equal(formatWorkDone(0, 45), "0 min of 45 min");
  assert.equal(formatWorkDone(30, 120), "30 min of 2 h");
  assert.equal(formatWorkDone(90, 120), "1 h 30 min of 2 h");
  assert.equal(formatWorkDone(120, 120, 95), "1 h 35 min", "once done, the real time replaces the estimate");
});

test("a working ticket shows its stage and when that stage started", async (t) => {
  const w = await screenshotRun(t);
  w.at(5);
  await w.run("ticket", "update", "o3", "--stage", "Build");
  w.at(40);
  await w.run("ticket", "update", "o3", "--stage", "Fixes");
  w.at(45);
  await w.run("ticket", "update", "o3", "--stage", "Fixes", "--note", "Same stage, no restart");
  const ticket = (await w.dashboard()).dashboard.tickets.find((candidate) => candidate.id === "o3");
  assert.equal(ticket?.stage, "Fixes");
  assert.equal(ticket?.stageSince, minutes(40).toISOString());
  assert.equal(ticket?.startedAt, minutes(0).toISOString());
  await w.run("ticket", "update", "o3", "--stage", "");
  const cleared = (await w.dashboard()).dashboard.tickets.find((candidate) => candidate.id === "o3");
  assert.equal(cleared?.stage, undefined);
});

test("a working ticket becomes stuck once it goes longer than its estimate without an update", async (t) => {
  const w = await screenshotRun(t);
  assert.deepEqual((await w.dashboard(120)).dashboard.stuck, [], "exactly at the estimate is not stuck");
  const { dashboard } = await w.dashboard(617);
  assert.deepEqual(dashboard.stuck, [{
    kind: "overdue", key: "overdue:o3", ticketId: "o3", title: "Ticket 03",
    since: minutes(0).toISOString(), estimateMin: 120,
  }]);
  assert.equal(headlineText(dashboard), "2 of 4 objectives done, 1 stuck");
  assert.deepEqual(dashboard.headline.at(-1), { text: "1 stuck", tone: "danger" });
});

test("a stage change, note or tagged activity restarts a working ticket's stuck clock", async (t) => {
  const w = await screenshotRun(t);
  w.at(100);
  await w.run("ticket", "update", "o3", "--stage", "Build");
  assert.deepEqual((await w.dashboard(200)).dashboard.stuck, [], "past the estimate since starting, but updated 100 min ago");
  w.at(210);
  await w.run("activity", "add", "Tests pass", "--ticket", "o3");
  w.at(215);
  await w.run("activity", "add", "Untagged work");
  const { dashboard } = await w.dashboard(340);
  assert.deepEqual(dashboard.stuck.map((item) => item.since), [minutes(210).toISOString()],
    "timed from the last update that belongs to the ticket");
});

test("conn set and clear keep one stored state, left out entirely when off", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  const next = minutes(55).toISOString();
  assert.equal("conn" in (await w.dashboard()).dashboard, false, "no conn until set");
  w.at(1);
  assert.equal((await w.run("conn", "set", "--budget", "2", "--mode", "live", "--next-nudge-at", next)).code, 0);
  assert.deepEqual((await w.dashboard()).dashboard.conn, { on: true, budget: 2, mode: "live", nextNudgeAt: next, since: minutes(1).toISOString() });
  w.at(30);
  await w.run("conn", "set", "--budget", "3", "--mode", "keepalive", "--next-nudge-at", next);
  assert.deepEqual((await w.dashboard()).dashboard.conn, { on: true, budget: 3, mode: "keepalive", nextNudgeAt: next, since: minutes(1).toISOString() }, "a rewrite keeps the original since");
  w.at(40);
  assert.equal((await w.run("conn", "clear")).code, 0);
  assert.equal("conn" in (await w.dashboard()).dashboard, false, "cleared conn leaves the field out");
  w.at(50);
  await w.run("conn", "set", "--budget", "2", "--mode", "live", "--next-nudge-at", next);
  assert.equal((await w.dashboard()).dashboard.conn?.since, minutes(50).toISOString(), "a new conn after a clear starts a new since");
});

test("show and show --json carry conn and the board indicator; conn is left out when off", async (t) => {
  const w = await worktree(t);
  const ws = ["--workspace", "wks_a"];
  await w.run("start", "Run", ...ws);
  await w.run("ticket", "add", "One", "--estimate", "30", ...ws);
  await w.run("ticket", "update", "o1", "--status", "in_progress", ...ws);
  const json = async () => JSON.parse((await w.run("show", "--json", ...ws)).text);
  const off = await json();
  assert.equal("conn" in off.dashboard, false, "no conn key while off");
  assert.deepEqual(off.indicator, [{ kind: "active", count: 1 }]);
  assert.doesNotMatch((await w.run("show", ...ws)).text, /Conn:|Status:/, "with conn off, plain show adds nothing");
  const next = minutes(55).toISOString();
  await w.run("conn", "set", ...ws, "--budget", "2", "--mode", "live", "--next-nudge-at", next);
  const on = await json();
  assert.deepEqual(on.dashboard.conn, { on: true, budget: 2, mode: "live", nextNudgeAt: next, since: minutes(0).toISOString() });
  assert.match((await w.run("show", ...ws)).text, /Conn: on, budget 2, live, since \S+, next nudge \S+\nStatus: Active 1$/);
});

test("the ticker icon spins only for active work, warns only for stalled work, and sits still when idle", () => {
  assert.equal(tickerIcon([{ kind: "idle" }], false), "idle", "an idle board gets no spinner and no warning");
  assert.equal(tickerIcon([{ kind: "active", count: 1 }], false), "live");
  assert.equal(tickerIcon([{ kind: "active", count: 1 }, { kind: "stuck", count: 2 }], false), "live");
  assert.equal(tickerIcon([{ kind: "stale", count: 1 }], false), "stale");
  assert.equal(tickerIcon([{ kind: "stale", count: 1 }, { kind: "stuck", count: 1 }], false), "stale");
  assert.equal(tickerIcon([{ kind: "stuck", count: 1 }], false), "idle", "stuck with nothing running is the indicator's job, not a stalled ticker");
  assert.equal(tickerIcon([{ kind: "stale", count: 1 }], true), "finished", "a finished board shows the check whatever else");
});

test("the indicator labels read Idle, Active N, Stale N and Stuck N", () => {
  assert.deepEqual(
    [{ kind: "idle" }, { kind: "active", count: 2 }, { kind: "stale", count: 1 }, { kind: "stuck", count: 3 }].map((status) => indicatorLabel(status as Indicator)),
    ["Idle", "Active 2", "Stale 1", "Stuck 3"],
  );
});

test("the conn label reads infinity and budget, plus a chequered flag only for full auto clear", () => {
  const conn = { on: true as const, budget: 2, mode: "live" as const, nextNudgeAt: "2026-10-15T09:30:00.000Z", since: "2026-10-15T08:00:00.000Z" };
  assert.equal(connLabel(conn), "♾️(2)");
  assert.equal(connLabel({ ...conn, clear: true }), "♾️(2) 🏁");
  assert.match(connDisplay({ ...conn, clear: true }, Date.parse(conn.nextNudgeAt)).hover, /until board autos cleared/i, "the flag's tooltip says what it means");
  assert.doesNotMatch(connDisplay(conn, Date.parse(conn.nextNudgeAt)).hover, /until board autos cleared/i, "no flag, no clear tooltip");
});

test("the conn sign is solid only while live and the engine is within 5 minutes of its next nudge", () => {
  const next = Date.parse("2026-10-15T09:30:00.000Z");
  const conn = (mode: "live" | "keepalive", nextNudgeAt = new Date(next).toISOString()) => ({ on: true as const, budget: 2, mode, nextNudgeAt, since: "2026-10-15T08:00:00.000Z" });
  const FIVE_MIN = 5 * 60_000;
  assert.equal(connDisplay(conn("live"), next - 10 * 60_000).solid, true, "live and before the nudge");
  assert.equal(connDisplay(conn("live"), next + FIVE_MIN).solid, true, "live, exactly 5 minutes past the nudge");
  assert.equal(connDisplay(conn("live"), next + FIVE_MIN + 1).solid, false, "past the window the engine went quiet, so dim");
  assert.equal(connDisplay(conn("keepalive"), next - 10 * 60_000).solid, false, "keepalive is never solid");
  assert.equal(connDisplay(conn("live", "not a time"), next).solid, false, "an unreadable nudge time never claims solid");
  const hover = connDisplay(conn("live"), next).hover;
  assert.match(hover, /budget 2/);
  assert.match(hover, /next nudge/);
  assert.match(connDisplay(conn("keepalive"), next).hover, /keep-alive/);
});

test("text show prints a set priority beside the status, and nothing when unset", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "Urgent", "--estimate", "30", "--priority", "1");
  await w.run("ticket", "add", "Plain", "--estimate", "30");
  const { text } = await w.run("show");
  assert.match(text, /o1  Open  P1  30 min  Urgent/);
  assert.match(text, /o2  Open  30 min  Plain/);
});

test("ticket show reads one ticket as text or json and refuses an unknown id", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "Urgent", "--estimate", "30", "--priority", "1");
  const text = await w.run("ticket", "show", "o1");
  assert.equal(text.code, 0);
  assert.match(text.text, /o1  Open  P1  30 min  Urgent/);
  const json = JSON.parse((await w.run("ticket", "show", "o1", "--json")).text);
  assert.deepEqual([json.ticket.id, json.ticket.status, json.ticket.priority], ["o1", "open", 1]);
  const unknown = await w.run("ticket", "show", "o9");
  assert.equal(unknown.code, 1);
  assert.match(unknown.text, /No ticket o9/);
});

test("show --json filters tickets by --status and --priority, and --ready lists what the seat may pull", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  const add = (title: string, ...flags: string[]) => w.run("ticket", "add", title, "--estimate", "10", ...flags);
  await add("A", "--priority", "0");
  await add("B", "--priority", "2", "--status", "in_progress");
  await add("C", "--priority", "3");
  await add("D");
  await add("E", "--priority", "1", "--status", "blocked");
  await add("F", "--priority", "0", "--status", "closed", "--close-reason", "done");
  const ids = async (...flags: string[]) => JSON.parse((await w.run("show", "--json", ...flags)).text).dashboard.tickets.map((ticket: Ticket) => ticket.id);
  assert.deepEqual(await ids("--status", "open"), ["o1", "o3", "o4"]);
  assert.deepEqual(await ids("--status", "open,in_progress"), ["o1", "o2", "o3", "o4"]);
  assert.deepEqual(await ids("--priority", "0-2"), ["o1", "o2", "o5", "o6"]);
  assert.deepEqual(await ids("--priority", "none"), ["o4"], "no priority is its own filter");
  assert.deepEqual(await ids("--priority", "3,none"), ["o3", "o4"]);
  assert.deepEqual(await ids("--ready"), ["o1", "o2"], "ready: open or in progress, P0 to P2; owner-held (P3, P4, none) never");
  assert.equal((await w.run("show", "--json", "--status", "done")).code, 1, "an unknown status is refused");
  assert.equal((await w.run("show", "--json", "--priority", "9")).code, 1, "an unknown priority is refused");
});

test("conn set --clear stores a clear flag that a plain rewrite drops", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  const next = minutes(55).toISOString();
  const set = (...extra: string[]) => w.run("conn", "set", "--budget", "2", "--mode", "live", "--next-nudge-at", next, ...extra);
  assert.equal((await set("--clear")).code, 0);
  assert.equal((await w.dashboard()).dashboard.conn?.clear, true);
  assert.equal(JSON.parse((await w.run("show", "--json")).text).dashboard.conn.clear, true, "show --json carries it");
  assert.match((await w.run("show")).text, /Conn: on, budget 2, clear, live, since/, "text show prints it by the budget");
  assert.match(connDisplay({ ...(await w.dashboard()).dashboard.conn!, clear: true }, Date.parse(next)).hover, /clear/, "the hover says it");
  await set();
  assert.equal("clear" in (await w.dashboard()).dashboard.conn!, false, "a rewrite without --clear drops it, key and all");
  assert.doesNotMatch((await w.run("show")).text, /budget 2, clear/);
});

test("closing the last open P0-P2 objective clears a conn that carries --clear, and says so", async (t) => {
  const w = await worktree(t);
  const next = minutes(55).toISOString();
  const conn = (...extra: string[]) => w.run("conn", "set", "--budget", "2", "--mode", "live", "--next-nudge-at", next, ...extra);
  const hasConn = async () => "conn" in JSON.parse((await w.run("show", "--json")).text).dashboard;
  const add = (title: string, ...flags: string[]) => w.run("ticket", "add", title, "--estimate", "10", ...flags);
  const LINE = /Board is clear: full auto clear is off\. Remove the ♾️ from your agent name and workspace name\./;
  await w.run("start", "Run");
  await add("Urgent", "--priority", "1");
  await add("Held", "--priority", "3");
  await conn("--clear");
  const closed = await w.run("ticket", "done", "o1");
  assert.match(closed.text, LINE);
  assert.equal(await hasConn(), false, "a P3 left open does not keep a clear conn alive");

  await conn();
  await add("Urgent again", "--priority", "0");
  const plain = await w.run("ticket", "done", "o3");
  assert.doesNotMatch(plain.text, /Board is clear/);
  assert.equal(await hasConn(), true, "a conn without clear is never touched");

  await conn("--clear");
  await add("Other", "--priority", "2");
  await add("Working", "--priority", "4", "--status", "in_progress");
  assert.doesNotMatch((await w.run("ticket", "done", "o4")).text, /Board is clear/);
  assert.equal(await hasConn(), true, "an objective in progress keeps it alive, whatever its priority");
  assert.match((await w.run("ticket", "done", "o5")).text, LINE);
  assert.equal(await hasConn(), false);

  await conn("--clear");
  await add("To skip", "--priority", "1");
  assert.match((await w.run("ticket", "update", "o6", "--status", "closed", "--close-reason", "skipped")).text, LINE, "a skipped close counts");
  assert.equal(await hasConn(), false);
});

test("conn clear with no conn, or no run at all, exits 0 and changes nothing", async (t) => {
  const w = await worktree(t);
  assert.equal((await w.run("conn", "clear")).code, 0, "no run, no conn");
  await w.run("start", "Run");
  assert.equal((await w.run("conn", "clear")).code, 0, "a run with no conn");
  assert.equal("conn" in (await w.dashboard()).dashboard, false);
});

test("only open or in-progress P0-P2 objectives are auto-pullable, conn or no conn", () => {
  const make = (status: Ticket["status"], priority?: number): Ticket => ({ id: "o1", title: "", estimateMin: 10, status, statusSince: "", history: [], priority });
  assert.deepEqual([0, 1, 2].map((priority) => isAutoPullable(make("open", priority))), [true, true, true]);
  assert.equal(isAutoPullable(make("in_progress", 2)), true);
  assert.deepEqual([3, 4, undefined].map((priority) => isAutoPullable(make("open", priority))), [false, false, false], "P3, P4 and no priority are owner-held");
  assert.equal(isAutoPullable(make("closed", 0)), false, "a finished objective is not picked up");
  assert.equal(isAutoPullable(make("blocked", 0)), false, "a blocked objective is not picked up");
});

test("conn set refuses a missing or invalid budget, mode or nudge time", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  const next = minutes(55).toISOString();
  for (const argv of [
    ["--budget", "0", "--mode", "live", "--next-nudge-at", next],
    ["--budget", "two", "--mode", "live", "--next-nudge-at", next],
    ["--budget", "2", "--mode", "auto", "--next-nudge-at", next],
    ["--budget", "2", "--mode", "live"],
    ["--budget", "2", "--mode", "live", "--next-nudge-at", "tomorrow"],
  ]) assert.equal((await w.run("conn", "set", ...argv)).code, 1, argv.join(" "));
  assert.equal("conn" in (await w.dashboard()).dashboard, false, "a refused set writes nothing");
});

test("conn set takes --workspace so the engine can write a seat's board from outside it", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Seat board", "--workspace", "wks_a");
  const next = minutes(55).toISOString();
  assert.equal((await w.run("conn", "set", "--workspace", "wks_a", "--budget", "2", "--mode", "live", "--next-nudge-at", next)).code, 0);
  assert.equal((await readProgress(w.store, minutes(0), "wks_a")).dashboard.conn?.budget, 2);
  assert.equal((await readProgress(w.store, minutes(0), "wks_b")).dashboard.conn, undefined, "another workspace's board has no conn");
});

test("a flag on a finished objective stops counting as stuck; a flag with no objective stays", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "One", "--estimate", "30");
  await w.run("ticket", "add", "Two", "--estimate", "30");
  await w.run("stuck", "set", "Needs a key", "--ticket", "o1");
  await w.run("stuck", "set", "Staging is down");
  assert.deepEqual((await w.dashboard()).dashboard.stuck.map((item) => item.key), ["manual:S1", "manual:S2"], "a flag on an open objective counts");
  await w.run("ticket", "update", "o1", "--status", "done");
  assert.deepEqual((await w.dashboard()).dashboard.stuck.map((item) => item.key), ["manual:S2"], "the finished objective's flag drops out");
});

test("blocked tickets and flagged blockers are stuck until cleared", async (t) => {
  const w = await screenshotRun(t);
  w.at(3);
  await w.run("ticket", "update", "o4", "--status", "blocked", "--note", "Waiting on the API key");
  assert.equal((await w.run("stuck", "set", "Staging is down", "--ticket", "t03")).text, "Flagged S1: Staging is down");
  const { dashboard } = await w.dashboard();
  assert.deepEqual(dashboard.stuck.map((item) => item.key), ["blocked:o4", "manual:S1"]);
  assert.equal(dashboard.stuck[0].since, minutes(3).toISOString());
  assert.equal(dashboard.stuck[1].title, "Ticket 03");
  assert.equal((await w.run("stuck", "clear", "s1")).text, "Cleared S1: Staging is down");
  assert.match((await w.run("stuck", "clear", "S1")).text, /No flagged blocker S1\. Flagged: none/);
  await w.run("ticket", "update", "o4", "--status", "working");
  assert.deepEqual((await w.dashboard()).dashboard.stuck, []);
  assert.match((await w.run("stuck", "set", "Again")).text, /^Flagged S2/, "ids are not reused");
});

test("questions carry the agent's recommendation and wait for the answer, then are answered by reference", async (t) => {
  const w = await screenshotRun(t);
  const ask = await w.run("question", "ask", "Row spacing", "Should we even out the spacing?",
    "--option", "A=Even it out | Cards look balanced",
    "--option", "b=Leave it | No change",
    "--recommend", "a",
    "--background", "13px left, 20px right.",
    "--file", ".scratch/shots/row.png=Before",
    "--raised-by", "Ticket 01 design review");
  assert.deepEqual(ask, { code: 0, text: "Asked Q1 (Row spacing). You recommend A. Build no option before the answer: work only on what it doesn't affect, and if nothing else is left, stop and wait." });
  await w.run("question", "ask", "PDF check", "Do the PDFs match the page?", "--recommend", "Looks right");
  let { dashboard } = await w.dashboard();
  assert.equal(headlineText(dashboard), "2 of 4 objectives done, 2 questions waiting for you");
  assert.deepEqual(dashboard.questions.open.map((question) => [question.id, question.recommended]), [["Q1", "A"], ["Q2", "Looks right"]]);
  assert.deepEqual(dashboard.questions.open[0].options[1], { letter: "B", label: "Leave it", consequence: "No change" });
  assert.deepEqual(dashboard.questions.open[0].files, [{ path: ".scratch/shots/row.png", label: "Before" }]);

  assert.equal((await w.run("question", "update", "Q1", "--background", "Walkthrough: 13px left, 20px right.", "--file", "shots/after.png=After")).text, "Updated Q1 (Row spacing)");
  ({ dashboard } = await w.dashboard());
  assert.equal(dashboard.questions.open[0].background, "Walkthrough: 13px left, 20px right.");
  assert.deepEqual(dashboard.questions.open[0].files.map((file) => file.label), ["Before", "After"]);
  assert.equal(dashboard.questions.open[0].recommended, "A", "updates keep the recommendation");
  assert.match((await w.run("question", "update", "Q1")).text, /Nothing to change/);
  assert.match((await w.run("question", "proceed", "Q1")).text, /Unknown command/, "there's no going ahead without the answer");

  w.at(20);
  assert.equal((await w.run("question", "answer", "q1", "b", "--words", "Leave it alone.")).text, "Answered Q1: B (not your recommendation, A). Build it now.");
  w.at(21);
  assert.equal((await w.run("question", "answer", "Q2", "Looks right")).text, "Answered Q2: Looks right (as you recommended). Build it now.");
  ({ dashboard } = await w.dashboard());
  assert.deepEqual(dashboard.questions.open, []);
  assert.deepEqual(dashboard.questions.answered.map((question) => question.id), ["Q2", "Q1"], "most recent answer first");
  assert.deepEqual(dashboard.questions.answered[1].answer, { choice: "B", words: "Leave it alone.", changedCourse: undefined, at: minutes(20).toISOString() });
  assert.equal(headlineText(dashboard), "2 of 4 objectives done");
});

test("questions from before recommendations show their default as the pick, and keep a changed course", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  const line = (event: object) => JSON.stringify({ v: 1, ts: minutes(0).toISOString(), ...event });
  await appendFile(join(w.store, "progress.jsonl"), [
    line({ type: "question.ask", id: "Q1", title: "Old", question: "Old?", default: "Yes", waits: true }),
    line({ type: "question.answer", id: "Q1", choice: "No", changedCourse: true }),
  ].join("\n") + "\n");
  const { dashboard } = await w.dashboard();
  assert.equal(dashboard.issues.length, 0);
  assert.deepEqual(dashboard.questions.answered.map((question) => [question.recommended, question.answer?.changedCourse]), [["Yes", true]]);
});

test("question references are never reused and bad questions are refused", async (t) => {
  const w = await screenshotRun(t);
  await w.run("question", "ask", "One", "First?", "--recommend", "Yes");
  assert.equal((await w.run("question", "remove", "Q1")).text, "Removed Q1 (One)");
  assert.match((await w.run("question", "ask", "Two", "Second?", "--recommend", "Yes")).text, /^Asked Q2/);
  await w.run("start", "Next run", "--replace");
  assert.match((await w.run("question", "ask", "Three", "Third?", "--recommend", "Yes")).text, /^Asked Q3/, "references stay unique across runs");
  const cases: Array<[string[], RegExp]> = [
    [["question", "ask", "T", "Q?", "--option", "A=One", "--option", "B=Two", "--recommend", "C"], /--recommend must be one of the option letters: A, B/],
    [["question", "ask", "T", "Q?"], /Missing --recommend \(the option you would pick\)/],
    [["question", "ask", "T", "Q?", "--option", "A=One", "--option", "a=Again", "--recommend", "A"], /Option A is given twice/],
    [["question", "ask", "T", "Q?", "--option", "One", "--recommend", "A"], /--option must look like/],
    [["question", "answer", "Q9", "A"], /No question Q9 in this run/],
    [["question", "remove", "Q1"], /No question Q1/],
  ];
  for (const [argv, message] of cases) {
    const result = await w.run(...argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.text, message);
  }
  await w.run("question", "ask", "Four", "Pick?", "--option", "A=One", "--option", "B=Two", "--recommend", "A");
  assert.match((await w.run("question", "answer", "Q4", "C")).text, /Q4 has options A, B, not C/);
});

test("deliverables are listed newest first with root-relative paths, their ticket, and a kind", async (t) => {
  const w = await screenshotRun(t);
  await mkdir(join(w.directory, ".scratch", "shots"), { recursive: true });
  const nested = join(w.directory, "packages", "app");
  await mkdir(nested, { recursive: true });
  assert.equal((await w.run("deliverable", "add", "Browser check screenshots", ".scratch/shots", "--ticket", "o3")).text, "Added D1: Browser check screenshots");
  const fromBelow = await runCli(["deliverable", "add", "Review report", "report.html", "--kind", "report"], { cwd: nested, now: () => minutes(1), out: () => {} });
  assert.equal(fromBelow, 0);
  await w.run("deliverable", "add", "Preview", "https://example.com/preview");
  await w.run("deliverable", "add", "Outside", "/tmp/elsewhere.png");
  const { dashboard } = await w.dashboard();
  assert.deepEqual(dashboard.deliverables.map(({ id, path, url, kind, ticketLabel }) => ({ id, path, url, kind, ticketLabel })), [
    { id: "D4", path: "/tmp/elsewhere.png", url: undefined, kind: "screenshot", ticketLabel: undefined },
    { id: "D3", path: undefined, url: "https://example.com/preview", kind: "link", ticketLabel: undefined },
    { id: "D2", path: "packages/app/report.html", url: undefined, kind: "report", ticketLabel: undefined },
    { id: "D1", path: ".scratch/shots", url: undefined, kind: "folder", ticketLabel: "Ticket 03" },
  ]);
  assert.equal((await w.run("deliverable", "remove", "d2")).text, "Removed D2: Review report");
  assert.deepEqual((await w.dashboard()).dashboard.deliverables.map((deliverable) => deliverable.id), ["D4", "D3", "D1"]);
  for (const [argv, message] of [
    [["deliverable", "add", "Bad", "ftp://example.com/x"], /Only http\(s\) URLs/],
    [["deliverable", "add", "Bad", "x.txt", "--kind", "video"], /--kind must be one of/],
    [["deliverable", "add", "Bad", "x.txt", "--ticket", "o9"], /No ticket o9/],
    [["deliverable", "remove", "D2"], /No deliverable D2/],
  ] as Array<[string[], RegExp]>) {
    const result = await w.run(...argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.text, message);
  }
});

test("activity notes list newest first and can be reworded or removed; the ticker sets and clears", async (t) => {
  const w = await screenshotRun(t);
  assert.equal((await w.run("activity", "add", "Dashboard set up.")).text, "Logged A1: Dashboard set up.");
  w.at(5);
  await w.run("activity", "add", "Ticket 03 moved to Fixes.");
  w.at(6);
  await w.run("activity", "add", "Typo");
  assert.equal((await w.run("activity", "update", "a2", "Ticket 03 moved to its Fixes stage.")).code, 0);
  await w.run("activity", "remove", "A3");
  assert.equal((await w.run("ticker", "set", "Running the browser check")).text, "Ticker: Running the browser check");
  let { dashboard } = await w.dashboard();
  assert.deepEqual(dashboard.activity.map(({ id, text, at }) => [id, text, at]), [
    ["A2", "Ticket 03 moved to its Fixes stage.", minutes(5).toISOString()],
    ["A1", "Dashboard set up.", minutes(0).toISOString()],
  ]);
  assert.deepEqual(dashboard.ticker, { text: "Running the browser check", since: minutes(6).toISOString() });
  await w.run("ticker", "clear");
  ({ dashboard } = await w.dashboard());
  assert.equal(dashboard.ticker, null);
  assert.match((await w.run("activity", "update", "A3", "Back")).text, /No activity A3 in this run\. Activity: A2, A1/);
  assert.match((await w.run("activity", "add", "Next")).text, /^Logged A4/);
});

test("bad lines are skipped and named while the rest of the dashboard renders", async (t) => {
  const w = await screenshotRun(t);
  const file = join(w.store, "progress.jsonl");
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.splice(2, 0, "{not json", JSON.stringify({ v: 2, ts: minutes(0).toISOString(), type: "ticket.add" }), JSON.stringify({ v: 1, ts: "yesterday", type: "ticket.add" }), "[]");
  const text = lines.join("\n") + JSON.stringify({ v: 1, ts: minutes(1).toISOString(), type: "ticket.update", id: "o9", status: "done" }) + "\n";
  await writeFile(file, `${text}{"v":1,"ts":"2026-09-27T20:00:00.000Z","type":"ticket.upd`);
  const { dashboard } = await w.dashboard();
  assert.equal(dashboard.progress.percent, 58, "good lines still count");
  assert.deepEqual(dashboard.issues, [
    { line: 3, reason: "not valid JSON" },
    { line: 4, reason: "written by a newer version of the plugin (v2)" },
    { line: 5, reason: "invalid ticket.add event" },
    { line: 6, reason: "not a progress event" },
    { line: 13, reason: "unknown ticket o9" },
  ], "the unfinished last line is skipped without an issue");
});

test("a new run shows a fresh dashboard while the old history stays in the file", async (t) => {
  const w = await screenshotRun(t);
  await w.run("question", "ask", "Old", "Old question?", "--recommend", "Yes");
  w.at(30);
  await w.run("start", "Second run", "--replace");
  const { dashboard } = await w.dashboard();
  assert.equal(dashboard.run?.title, "Second run");
  assert.deepEqual([dashboard.tickets, dashboard.questions.open, dashboard.stuck], [[], [], []]);
  assert.match((await w.run("ticket", "add", "Fresh", "--estimate", "5")).text, /^Added o1/, "ticket ids restart per run");
  const history = await readFile(join(w.store, "progress.jsonl"), "utf8");
  assert.match(history, /"title":"Loan Options"/);
});

test("concurrent writers never share an id or produce a broken line", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Busy");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const spawned = Array.from({ length: 6 }, (_, index) =>
    promisify(execFile)(process.execPath, [cli, "ticket", "add", `Spawned ${index}`, "--estimate", "5"], { cwd: w.directory }));
  const inProcess = Array.from({ length: 14 }, (_, index) =>
    runCli(["ticket", "add", `Local ${index}`, "--estimate", "5"], { cwd: w.directory, out: () => {} }));
  await Promise.all([...spawned, ...inProcess]);
  const { dashboard } = await w.dashboard();
  const ids = dashboard.tickets.map((ticket) => ticket.id);
  assert.equal(ids.length, 20);
  assert.equal(new Set(ids).size, 20, "every ticket got its own id");
  assert.deepEqual(dashboard.issues, []);
  const text = await readFile(join(w.store, "progress.jsonl"), "utf8");
  assert.ok(text.endsWith("\n") && text.trim().split("\n").every((line) => JSON.parse(line)));
});

test("a lock left behind by a crashed command is taken over", async (t) => {
  const w = await worktree(t);
  const lock = join(w.store, "progress.jsonl.lock");
  await mkdir(lock, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal((await w.run("start", "After crash")).code, 0);
});

test("show prints the dashboard as text for the agent", async (t) => {
  const w = await screenshotRun(t);
  await w.run("ticket", "update", "o3", "--stage", "Fixes");
  await w.run("question", "ask", "Row spacing", "Even out the spacing?", "--option", "A=Yes", "--option", "B=No", "--recommend", "B");
  await w.run("deliverable", "add", "Screenshots", ".scratch/shots/", "--ticket", "o3");
  await w.run("activity", "add", "Ticket 03 moved to Fixes.");
  const { code, text } = await runShow(w, 617);
  assert.equal(code, 0);
  assert.ok(text.startsWith(`Worktree: ${w.directory}\n`), "show names the worktree it read");
  for (const expected of [
    "Loan Options",
    "2 of 4 objectives done, 1 question waiting for you, 1 stuck",
    "58% of estimated work done, 4 h 30 min of 7 h 45 min",
    "POSSIBLY STALE: no update for 10 h 17 min.",
    "Ticket 03 (no update for longer than its 2 h estimate)",
    "o3  In progress, Fixes stage  2 h  Ticket 03",
    "Q1 (Row spacing): Even out the spacing? You recommended B",
    "      B) No",
    "D1  Screenshots: .scratch/shots/, Ticket 03",
    "A1  Ticket 03 moved to Fixes.",
  ]) assert.ok(text.includes(expected), `missing: ${expected}\n\n${text}`);
});

async function runShow(w: Awaited<ReturnType<typeof worktree>>, minute: number) {
  const output: string[] = [];
  const code = await runCli(["show"], { cwd: w.directory, now: () => minutes(minute), out: (line) => output.push(line) });
  return { code, text: output.join("\n") };
}

test("the launcher runs the command from the plugin folder Paseo reports", async (t) => {
  const w = await worktree(t);
  const target = join(w.directory, "bin", "paseo-progress");
  assert.equal((await runCli(["install-launcher", target], { cwd: w.directory, out: () => {} })), 0);
  const output: string[] = [];
  await runCli(["install-launcher", target], { cwd: w.directory, out: (line) => output.push(line) });
  assert.match(output[0], /already current/);
  const pluginDir = fileURLToPath(new URL("..", import.meta.url));
  const { stdout } = await promisify(execFile)(target, ["start", "Via launcher"], {
    cwd: w.directory,
    env: { ...process.env, PASEO_PROGRESS_PLUGIN_DIR: pluginDir },
  });
  assert.equal(stdout.trim(), "Started run: Via launcher");
  await assert.rejects(
    promisify(execFile)(target, ["show"], { cwd: w.directory, env: { ...process.env, PASEO_PROGRESS_PLUGIN_DIR: join(w.directory, "nowhere") } }),
    /not installed in Paseo/,
  );
});

// Owner ruling (12 Oct): there is one plugin, the checkout, so the command
// runs its source — the same code a reload hands the panel. A leftover
// dist/ snapshot once kept the CLI on an old fold after the panel moved on.
test("the launcher runs the plugin's source, never a dist snapshot", async (t) => {
  const w = await worktree(t);
  const target = join(w.directory, "bin", "paseo-progress");
  await runCli(["install-launcher", target], { cwd: w.directory, out: () => {} });
  const plugin = join(w.directory, "fake-plugin");
  await mkdir(join(plugin, "dist", "server"), { recursive: true });
  await mkdir(join(plugin, "server"), { recursive: true });
  await writeFile(join(plugin, "dist", "server", "cli.js"), `console.log("stale snapshot");\n`);
  await writeFile(join(plugin, "server", "cli.ts"), `console.log("source");\n`);
  const { stdout } = await promisify(execFile)(target, [], { cwd: w.directory, env: { ...process.env, PASEO_PROGRESS_PLUGIN_DIR: plugin } });
  assert.equal(stdout.trim(), "source");
});

test("the launcher is installed only on request, updated when stale, and never replaces another file", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "progress-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = defaultLauncherPath(home);
  assert.equal(path, join(home, ".local", "bin", "paseo-progress"));
  const bin = join(home, ".local", "bin");
  assert.deepEqual(await launcherStatus(path, `/usr/bin:${bin}/`), { path, state: "missing", onPath: true });
  assert.equal(await installLauncher(path), true);
  assert.deepEqual(await launcherStatus(path, "/usr/bin"), { path, state: "current", onPath: false });
  assert.equal(await installLauncher(path), false, "a current launcher is left as is");
  await writeFile(path, `#!/usr/bin/env node\n// Written by the progress Paseo plugin. old\n`);
  assert.equal((await launcherStatus(path)).state, "outdated");
  assert.equal(await installLauncher(path), true);
  const other = join(bin, "other");
  await writeFile(other, "#!/bin/sh\necho mine\n");
  assert.equal((await launcherStatus(other)).state, "foreign");
  await assert.rejects(installLauncher(other), /was not written by this plugin/);
  assert.equal(await readFile(other, "utf8"), "#!/bin/sh\necho mine\n");
});

test("a local deliverable opens on the daemon host by id, only inside the worktree", async (t) => {
  const w = await screenshotRun(t);
  await mkdir(join(w.directory, "reports"), { recursive: true });
  await writeFile(join(w.directory, "reports", "review.html"), "<h1>Review</h1>");
  await w.run("deliverable", "add", "Review", "reports/review.html");
  await w.run("deliverable", "add", "Gone", "reports/missing.html");
  await w.run("deliverable", "add", "Outside", tmpdir());
  await w.run("deliverable", "add", "Preview", "https://example.com");
  const opened: string[] = [];
  const opener = async (path: string) => { opened.push(path); };
  const root = await realpath(w.directory);
  assert.deepEqual(await openDeliverable(w.directory, "D1", opener), { opened: join(root, "reports", "review.html") });
  assert.deepEqual(opened, [join(root, "reports", "review.html")]);
  await assert.rejects(openDeliverable(w.directory, "D2", opener), /reports\/missing\.html no longer exists/);
  await assert.rejects(openDeliverable(w.directory, "D3", opener), /is outside this worktree/);
  await assert.rejects(openDeliverable(w.directory, "D4", opener), /No local deliverable D4/, "web links are not opened on the host");
  await assert.rejects(openDeliverable(w.directory, "D9", opener), /No local deliverable D9/);
  assert.equal(opened.length, 1);
});

test("every screen gives an attachment the same icon, and SVGs preview only where a browser draws them", async (t) => {
  const w = await screenshotRun(t);
  await w.run("deliverable", "add", "Findings", "notes/findings.md", "--kind", "report");
  await w.run("deliverable", "add", "Logo", "art/logo.svg");
  await w.run("question", "ask", "Logo", "Which logo?", "--recommend", "A", "--file", "art/logo.svg=Current");
  const { dashboard } = await readProgress(w.store);
  const report = findAttachment(dashboard, dashboard.deliverables.find((entry) => entry.title === "Findings")!.id)!;
  assert.equal(attachmentIcon(report), "FileChartColumn", "the recorded kind wins over the extension, wherever the deliverable is listed");
  assert.equal(attachmentIcon(deliverableAttachment(dashboard.deliverables.find((entry) => entry.title === "Findings")!)), "FileChartColumn");
  const logo = dashboard.deliverables.find((entry) => entry.title === "Logo")!;
  assert.equal(logo.kind, "screenshot");
  const questionFile = findAttachment(dashboard, `${dashboard.questions.open[0].id}.1`)!;
  assert.deepEqual([questionFile.title, questionFile.path, attachmentIcon(questionFile)], ["Current", "art/logo.svg", "Image"]);
  assert.equal(canPreview(questionFile, { browser: true }), true);
  assert.equal(canPreview(questionFile, { browser: false }), false, "phone apps can't draw SVG");
  assert.equal(canPreview({ ref: "D9", title: "Shot", path: "a.png" }, { browser: false }), true);
});

test("image and text deliverables preview, only inside the worktree", async (t) => {
  const w = await screenshotRun(t);
  await mkdir(join(w.directory, "shots"), { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  await writeFile(join(w.directory, "shots", "home.PNG"), png);
  await writeFile(join(w.directory, "shots", "notes.md"), "# Notes");
  await writeFile(join(w.directory, "shots", "huge.jpg"), Buffer.alloc(MAX_PREVIEW_BYTES + 1));
  await w.run("deliverable", "add", "Home", "shots/home.PNG");
  await w.run("deliverable", "add", "Notes", "shots/notes.md");
  await w.run("deliverable", "add", "Huge", "shots/huge.jpg");
  await w.run("deliverable", "add", "Outside", join(tmpdir(), "elsewhere.png"));
  assert.deepEqual(await previewDeliverable(w.directory, "D1"), { kind: "image", dataUri: `data:image/png;base64,${png.toString("base64")}`, bytes: png.length });
  assert.deepEqual(await previewDeliverable(w.directory, "D2"), { kind: "text", text: "# Notes", bytes: 7, truncated: false });
  await writeFile(join(w.directory, "shots", "page.html"), "<h1>Hi</h1>");
  await w.run("deliverable", "add", "Page", "shots/page.html");
  await assert.rejects(previewDeliverable(w.directory, "D5"), /isn't an image or text file/, "HTML is left to the browser");
  await assert.rejects(previewDeliverable(w.directory, "D3"), /too large to preview/);
  await assert.rejects(previewDeliverable(w.directory, "D4"), /no longer exists|outside this worktree/);
  const longLog = "x".repeat(MAX_PREVIEW_TEXT_BYTES + 10);
  await writeFile(join(w.directory, "shots", "long.log"), longLog);
  await writeFile(join(w.directory, "shots", "empty.txt"), "");
  await w.run("deliverable", "add", "Long", "shots/long.log");
  await w.run("deliverable", "add", "Empty", "shots/empty.txt");
  assert.deepEqual(await previewDeliverable(w.directory, "D6"), { kind: "text", text: longLog.slice(0, MAX_PREVIEW_TEXT_BYTES), bytes: longLog.length, truncated: true });
  assert.deepEqual(await previewDeliverable(w.directory, "D7"), { kind: "text", text: "", bytes: 0, truncated: false });
  assert.equal(imageMimeType("a/b.jpeg"), "image/jpeg");
  assert.equal(imageMimeType("report.html"), null);
});

test("question attachments take paths or links, and open and preview like deliverables", async (t) => {
  const w = await screenshotRun(t);
  await mkdir(join(w.directory, "shots"), { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  await writeFile(join(w.directory, "shots", "before.png"), png);
  await w.run("question", "ask", "Header", "Which header?", "--option", "A=Old", "--option", "B=New", "--recommend", "A",
    "--file", "shots/before.png=Before", "--file", "https://example.com/preview?id=7&tab=2=Live preview", "--file", "https://example.com/?q=1");
  const { dashboard } = await readProgress(w.store);
  assert.deepEqual(dashboard.questions.open[0].files, [
    { path: "shots/before.png", label: "Before" },
    { url: "https://example.com/preview?id=7&tab=2", label: "Live preview" },
    { url: "https://example.com/?q=1" },
  ], "an = after a query key stays in the URL");
  assert.equal(findAttachment(dashboard, "Q1.1")?.path, "shots/before.png");
  assert.equal(findAttachment(dashboard, "Q1.2")?.path, undefined, "links are not opened on the host");
  assert.equal(findAttachment(dashboard, "Q1.4"), null);
  assert.deepEqual(await previewDeliverable(w.directory, "Q1.1"), { kind: "image", dataUri: `data:image/png;base64,${png.toString("base64")}`, bytes: png.length });
  const opened: string[] = [];
  await openDeliverable(w.directory, "Q1.1", async (path) => { opened.push(path); });
  assert.deepEqual(opened, [join(await realpath(w.directory), "shots", "before.png")]);
  await assert.rejects(openDeliverable(w.directory, "Q1.9", async () => {}), /No local attachment Q1\.9/);
  const ftp = await w.run("question", "update", "Q1", "--file", "ftp://example.com/x");
  assert.equal(ftp.code, 1);
  assert.match(ftp.text, /Only http\(s\) URLs/);
});

test("plain-text deliverables open in the default browser; everything else in its usual app", () => {
  assert.deepEqual(openCommand("/w/spec.md", "darwin", "com.google.chrome"), ["open", ["-b", "com.google.chrome", "/w/spec.md"]]);
  assert.deepEqual(openCommand("/w/NOTES.TXT", "darwin", null), ["open", ["-b", "com.apple.Safari", "/w/NOTES.TXT"]], "Safari when no default browser is set");
  assert.deepEqual(openCommand("/w/report.html", "darwin", "com.google.chrome"), ["open", ["/w/report.html"]]);
  assert.deepEqual(openCommand("/w/shots/", "darwin", "com.google.chrome"), ["open", ["/w/shots/"]]);
  assert.deepEqual(openCommand("/w/spec.md", "linux", null), ["xdg-open", ["/w/spec.md"]]);
});

test("the skill is linked for every agent only on request, follows the copy Paseo runs, and never replaces another file", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "progress-skill-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = defaultSkillPaths(home);
  assert.deepEqual(paths.map((path) => path.slice(home.length)), ["/.agents/skills/paseo-progress", "/.claude/skills/paseo-progress", "/.codex/skills/paseo-progress"]);
  const plugin = join(home, "plugin");
  assert.equal((await skillStatus(paths, plugin)).state, "missing");
  await mkdir(paths[2], { recursive: true });
  assert.equal(await installSkill(paths, plugin), true);
  assert.equal(await readlink(paths[0]), skillSource(plugin));
  assert.equal(await readlink(paths[1]), skillSource(plugin));
  assert.deepEqual(await skillStatus(paths, plugin), {
    state: "current",
    targets: [{ path: paths[0], state: "current" }, { path: paths[1], state: "current" }, { path: paths[2], state: "foreign" }],
  }, "someone else's skill folder is left alone");
  assert.equal(await installSkill(paths, plugin), false, "current links are left as is");
  const moved = join(home, "other-checkout");
  assert.equal((await skillStatus(paths, moved)).state, "outdated", "Paseo now runs another copy");
  assert.equal(await installSkill(paths, moved), true);
  assert.equal(await readlink(paths[1]), skillSource(moved));
  await assert.rejects(installSkill([paths[2]], plugin), /were not linked by this plugin/);
});



// A fresh repo, and the command run in any worktree of it.
async function newRepo(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "progress-repo-")));
  const linked = `${directory}-linked`;
  t.after(() => Promise.all([directory, linked].map((path) => rm(path, { recursive: true, force: true }))));
  await git(directory, "init", "-q");
  // A public origin keeps run saving off, as before o22; the o22 tests set their own.
  await git(directory, "remote", "add", "origin", "https://github.com/example/widgets.git");
  const output: string[] = [];
  return {
    directory, linked,
    setOrigin: (url: string | null) => (url === null ? git(directory, "remote", "remove", "origin") : git(directory, "remote", "set-url", "origin", url)),
    async run(cwd: string, ...argv: string[]) {
      output.length = 0;
      const code = await runCli(argv, { cwd, now: () => minutes(0), out: (line) => output.push(line) });
      return { code, text: output.join("\n") };
    },
    // What `git status` lists, one path per line.
    visible: async (cwd = directory) => (await git(cwd, "status", "--porcelain", "-uall")).split("\n").filter(Boolean).map((line) => line.slice(3)),
    async addWorktree() {
      await git(directory, "add", "-A");
      await git(directory, "commit", "-q", "--allow-empty", "-m", "init");
      await git(directory, "worktree", "add", "-q", linked);
    },
  };
}

const context = { paseo: {} as PluginHandlerContext["paseo"] };
const OLD_GITIGNORE = "# Added by the progress plugin for Paseo so its files stay out of git.\nprogress.jsonl\nprogress.jsonl.lock/\nprogress-panel-opened\n.gitignore\n";
const startLine = (title: string) => `${JSON.stringify({ v: 1, ts: "2026-09-01T10:00:00.000Z", type: "run.start", title })}\n`;

// What 0.1.x left in a worktree.
async function oldScratch(tree: string, extra: Record<string, string> = {}) {
  await mkdir(join(tree, ".scratch"), { recursive: true });
  await writeFile(join(tree, ".scratch", ".gitignore"), OLD_GITIGNORE);
  await writeFile(join(tree, ".scratch", "progress.jsonl"), startLine("Old run"));
  await writeFile(join(tree, ".scratch", "progress-panel-opened"), "");
  for (const [name, text] of Object.entries(extra)) await writeFile(join(tree, ".scratch", name), text);
}

test("progress lives outside the repo: no setup, nothing for git to see", async (t) => {
  const repo = await newRepo(t);
  assert.equal((await repo.run(repo.directory, "start", "Run")).code, 0);
  assert.deepEqual(await repo.visible(), []);
  assert.equal(await readdir(repo.directory).then((names) => names.includes(".scratch")), false);
  const result = await handleGetDashboard({ workspaceId: "ws-1", workspaceDirectory: repo.directory }, context);
  assert.ok("dashboard" in result);
  assert.equal(result.dashboard.run?.title, "Run");
  assert.match(result.file, /^~\/\.local\/state\/paseo-progress\/progress-repo-[^/]+-[0-9a-f]{8}\/progress\.jsonl$/);
  assert.equal(result.savedTo, null);
  assert.equal(result.inRepo, true);
});

test("outside git it works the same", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "progress-nogit-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await runCli(["start", "Run"], { cwd: directory, now: () => minutes(0), out: () => {} })), 0);
  assert.equal((await findStore(directory)).directory, outsideDirectory(directory));
  assert.deepEqual(await readdir(directory), []);
  const result = await handleGetDashboard({ workspaceId: "ws-1", workspaceDirectory: directory }, context);
  assert.ok("dashboard" in result);
  assert.equal(result.inRepo, false, "no repo to save history in, so the panel doesn't offer it");
});

test("a run 0.1.x left in .scratch moves outside the first time anything reads it, and .scratch is tidied", async (t) => {
  const repo = await newRepo(t);
  await oldScratch(repo.directory, { "notes.md": "mine" });
  const result = await handleGetDashboard({ workspaceId: "ws-1", workspaceDirectory: repo.directory }, context);
  assert.ok("dashboard" in result);
  assert.deepEqual([result.dashboard.run?.title, result.panelOpened], ["Old run", true]);
  assert.deepEqual(await readdir(join(repo.directory, ".scratch")), ["notes.md"], "only the plugin's files go; the user's stay");
  assert.equal((await repo.run(repo.directory, "activity", "add", "After the move")).code, 0);
  assert.match(await readFile(join(outsideDirectory(repo.directory), "progress.jsonl"), "utf8"), /Old run[\s\S]*After the move/);

  const bare = await newRepo(t);
  await oldScratch(bare.directory);
  await bare.run(bare.directory, "show");
  assert.equal(await readdir(bare.directory).then((names) => names.includes(".scratch")), false, "an emptied .scratch goes too");
});

test("a repo's own .scratch/.gitignore is never removed, and its files stop showing in git", async (t) => {
  const repo = await newRepo(t);
  await oldScratch(repo.directory);
  await writeFile(join(repo.directory, ".scratch", ".gitignore"), "drafts/\n");
  assert.deepEqual(await repo.visible(), [".scratch/.gitignore", ".scratch/progress-panel-opened", ".scratch/progress.jsonl"]);
  await repo.run(repo.directory, "show");
  assert.equal(await readFile(join(repo.directory, ".scratch", ".gitignore"), "utf8"), "drafts/\n");
  assert.deepEqual(await repo.visible(), [".scratch/.gitignore"]);
});

test("a run 0.1.x left in .scratch that git tracks stays and is used in place", async (t) => {
  const repo = await newRepo(t);
  await oldScratch(repo.directory);
  await writeFile(join(repo.directory, ".scratch", ".gitignore"), "drafts/\n");
  await git(repo.directory, "add", "-A");
  await git(repo.directory, "commit", "-qm", "progress committed by an agent");
  assert.equal((await repo.run(repo.directory, "activity", "add", "Still here")).code, 0);
  assert.match(await readFile(join(repo.directory, ".scratch", "progress.jsonl"), "utf8"), /Still here/);
  assert.deepEqual(await repo.visible(), [".scratch/progress.jsonl"], "modified, as it always was, never deleted");
  const result = await handleGetDashboard({ workspaceId: "ws-1", workspaceDirectory: repo.directory }, context);
  assert.ok("dashboard" in result);
  assert.equal(result.file, ".scratch/progress.jsonl");
});

test("lines written to the old place during a move are picked up, not lost", async (t) => {
  const repo = await newRepo(t);
  await repo.run(repo.directory, "start", "New run");
  await mkdir(join(repo.directory, ".scratch"));
  await writeFile(join(repo.directory, ".scratch", "progress.jsonl"), `${JSON.stringify({ v: 1, ts: "2026-09-27T20:01:00.000Z", type: "activity.add", id: "A1", text: "Late line" })}\n`);
  const result = await handleGetDashboard({ workspaceId: "ws-1", workspaceDirectory: repo.directory }, context);
  assert.ok("dashboard" in result);
  assert.equal(result.dashboard.run?.title, "New run");
  assert.deepEqual(result.dashboard.activity.map((entry) => entry.text), ["Late line"]);
});

test("saving run history is opt-in: one file per run in the chosen folder, in every worktree", async (t) => {
  const repo = await newRepo(t);
  await repo.addWorktree();
  const set = (folder: string | null, tree = repo.directory) => handleSetHistoryFolder({ workspaceId: "ws-1", workspaceDirectory: tree, folder }, context);
  assert.deepEqual(await set("history/"), { savedTo: "history" });
  await repo.run(repo.directory, "start", "First run");
  await repo.run(repo.directory, "activity", "add", "Did a thing");
  await repo.run(repo.linked, "start", "Linked run");
  const first = runFileName(minutes(0).toISOString(), "First run");
  assert.equal(first, "20260927-195900-first-run.jsonl");
  const saved = await readFile(join(repo.directory, "history", first), "utf8");
  assert.deepEqual(saved.trim().split("\n").map((line) => JSON.parse(line).type), ["run.start", "activity.add"]);
  assert.deepEqual(await repo.visible(), [`history/${first}`], "only the run file; no lock or marker");
  assert.deepEqual(await repo.visible(repo.linked), [`history/${runFileName(minutes(0).toISOString(), "Linked run")}`], "the setting covers every worktree");

  await repo.run(repo.directory, "start", "Second run", "--replace");
  assert.deepEqual((await readdir(join(repo.directory, "history"))).sort(), [first, runFileName(minutes(0).toISOString(), "Second run")].sort(), "a new run gets its own file");
  assert.deepEqual(JSON.parse((await readFile(join(repo.directory, "history", runFileName(minutes(0).toISOString(), "Second run")), "utf8")).trim()).title, "Second run");

  assert.deepEqual(await set(null), { savedTo: null });
  assert.deepEqual(await set(null), { savedTo: null }, "stopping twice is fine");
  await repo.run(repo.directory, "activity", "add", "Not saved");
  assert.doesNotMatch(await readFile(join(repo.directory, "history", runFileName(minutes(0).toISOString(), "Second run")), "utf8"), /Not saved/);
  assert.ok(await readFile(join(repo.directory, "history", first), "utf8"), "files already saved stay");
});

test("run history only goes to folders inside the repo", async (t) => {
  const repo = await newRepo(t);
  for (const folder of ["", " ", "../elsewhere", "/tmp/x", ".", ".git", ".git/x"]) {
    await assert.rejects(handleSetHistoryFolder({ workspaceId: "ws-1", workspaceDirectory: repo.directory, folder }, context), `rejects "${folder}"`);
  }
});

test("the folder picker lists the repo's folders, without .git or links", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo.directory, "src", "app"), { recursive: true });
  await mkdir(join(repo.directory, ".scratch"));
  await writeFile(join(repo.directory, "README.md"), "");
  await symlink(tmpdir(), join(repo.directory, "elsewhere"));
  const list = (folder: string) => handleListFolders({ workspaceId: "ws-1", workspaceDirectory: repo.directory, folder }, context);
  assert.deepEqual(await list(""), { folder: "", folders: [".scratch", "src"] });
  assert.deepEqual(await list("src"), { folder: "src", folders: ["app"] });
  assert.deepEqual(await list("new/folder"), { folder: "new/folder", folders: [] }, "a folder that doesn't exist yet is empty");
  await assert.rejects(list("../"), /inside the repo/);
});

// o34: HOLD the board. A stored state like conn: items can still be added, but
// nothing starts. Closed means no work at all; speccing means the owner is here.
test("hold set and clear keep one stored state, left out when off, and refuse a bad kind", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  assert.equal("hold" in (await w.dashboard()).dashboard, false, "no hold until set");
  w.at(1);
  assert.equal((await w.run("hold", "set", "--kind", "speccing", "--note", "with Des")).code, 0);
  assert.deepEqual((await w.dashboard()).dashboard.hold, { on: true, kind: "speccing", note: "with Des", since: minutes(1).toISOString() });
  w.at(30);
  await w.run("hold", "set", "--kind", "closed");
  assert.deepEqual((await w.dashboard()).dashboard.hold, { on: true, kind: "closed", since: minutes(1).toISOString() }, "a rewrite keeps the since and drops a note it did not carry");
  w.at(40);
  assert.equal((await w.run("hold", "clear")).code, 0);
  assert.equal("hold" in (await w.dashboard()).dashboard, false, "cleared hold leaves the field out");
  for (const argv of [["hold", "set"], ["hold", "set", "--kind", "paused"]]) {
    const refused = await w.run(...argv);
    assert.equal(refused.code, 1, argv.join(" "));
    assert.match(refused.text, /--kind/);
  }
});

test("while the board is on hold, items can be added and closed but no work starts", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "Running", "--estimate", "30");
  await w.run("ticket", "add", "Waiting", "--estimate", "30");
  await w.run("ticket", "update", "o1", "--status", "in_progress");
  await w.run("hold", "set", "--kind", "closed");
  const refusals = [
    ["ticket", "claim", "o2"],
    ["ticket", "update", "o2", "--status", "in_progress"],
    ["ticket", "add", "Eager", "--estimate", "30", "--status", "in_progress"],
  ];
  for (const argv of refusals) {
    const refused = await w.run(...argv);
    assert.equal(refused.code, 1, argv.join(" "));
    assert.match(refused.text, /on hold.*closed.*hold clear/is, "names the hold and how to lift it");
  }
  assert.equal((await w.dashboard()).dashboard.tickets.find((ticket) => ticket.id === "o2")?.status, "open", "nothing started");
  for (const argv of [
    ["ticket", "add", "Spec this", "--estimate", "30"],
    ["ticket", "update", "o2", "--priority", "1", "--note", "scoped"],
    ["ticket", "update", "o1", "--note", "still going", "--status", "in_progress"],
    ["ticket", "done", "o1"],
  ]) assert.equal((await w.run(...argv)).code, 0, argv.join(" "));
  await w.run("hold", "clear");
  assert.equal((await w.run("ticket", "claim", "o2")).code, 0, "work starts again once the hold is lifted");
});

test("show carries the hold, --ready lists nothing while it is on, and plain show is unchanged when off", async (t) => {
  const w = await worktree(t);
  await w.run("start", "Run");
  await w.run("ticket", "add", "Urgent", "--estimate", "30", "--priority", "0");
  const plain = (await w.run("show")).text;
  assert.doesNotMatch(plain, /Hold:/);
  assert.match((await w.run("show", "--ready")).text, /o1/);
  await w.run("hold", "set", "--kind", "speccing", "--note", "with Des");
  const held = (await w.run("show")).text;
  assert.match(held, /Hold: speccing, since \S+, with Des$/m);
  assert.doesNotMatch((await w.run("show", "--ready")).text, /o1 /, "nothing is ready to pull while on hold");
  assert.deepEqual(JSON.parse((await w.run("show", "--json")).text).dashboard.hold.kind, "speccing");
});

test("a speccing hold only pauses full auto: conn and the objective marks stay, and clearing the hold needs no re-activation", async (t) => {
  const w = await worktree(t);
  const next = minutes(55).toISOString();
  await w.run("start", "Run");
  await w.run("ticket", "add", "Urgent", "--estimate", "30", "--priority", "1");
  await w.run("conn", "set", "--budget", "2", "--mode", "live", "--next-nudge-at", next, "--clear");
  const before = (await w.dashboard()).dashboard.conn;
  assert.equal(before?.clear, true);
  for (const kind of ["speccing", "closed"]) {
    await w.run("hold", "set", "--kind", kind);
    const held = (await w.dashboard()).dashboard;
    assert.deepEqual(held.conn, before, `${kind}: conn is exactly as it was, since and all`);
    assert.equal(isAutoPullable(held.tickets.find((ticket) => ticket.id === "o1")!), true, `${kind}: the objective keeps its mark`);
    assert.match((await w.run("show")).text, /Conn: on, budget 2, clear, live/, `${kind}: text show still says full auto is on`);
    await w.run("hold", "clear");
    const lifted = (await w.dashboard()).dashboard;
    assert.deepEqual(lifted.conn, before, `${kind}: full auto runs again after the hold clears, nothing re-activated`);
    assert.equal("hold" in lifted, false);
    assert.match((await w.run("show", "--ready")).text, /o1 /, `${kind}: the ready list is back`);
  }
});

// o38 (Des, 16 Oct): the Progress page sets a board's state, and an idle board
// turning active pings its owner seat to continue.
test("setBoardMode writes the hold for hold and spec, lifts it going active, and pings the owner only when a board turns active", async (t) => {
  const w = await worktree(t);
  const input = { workspaceId: "ws", workspaceDirectory: w.directory };
  const cli = (...argv: string[]) => runCli(argv, { cwd: w.directory, workspaceId: "ws", now: () => minutes(0), out: () => {} });
  const sent: [string, string][] = [];
  const ctx = { paseo: { agents: { ref: (id: string) => ({ send: async (text: string) => { sent.push([id, text]); } }) } } as unknown as PluginHandlerContext["paseo"] };
  const board = async () => (await handleGetDashboard(input, ctx) as { dashboard: Dashboard }).dashboard;
  await cli("start", "Run");

  assert.deepEqual(await handleSetBoardMode({ ...input, mode: "spec", agentId: "seat" }, ctx), { mode: "spec", pinged: false });
  assert.equal((await board()).hold?.kind, "speccing");
  assert.deepEqual(sent, [], "going idle pings nobody");
  assert.deepEqual(await handleSetBoardMode({ ...input, mode: "hold", agentId: "seat" }, ctx), { mode: "hold", pinged: false });
  assert.equal((await board()).hold?.kind, "closed", "hold swaps the kind");

  const up = await handleSetBoardMode({ ...input, mode: "fullauto", agentId: "seat" }, ctx);
  assert.deepEqual(up, { mode: "fullauto", pinged: true });
  assert.equal((await board()).hold, undefined, "going active lifts the hold");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "seat");
  assert.match(sent[0][1], /^\/fullauto — Des switched this board to Full auto from the Progress page\. Continue\.$/);

  // A board with its full auto already on: spec, then back, needs only Continue.
  await cli("conn", "set", "--budget", "2", "--mode", "live", "--next-nudge-at", minutes(55).toISOString());
  await handleSetBoardMode({ ...input, mode: "spec", agentId: "seat" }, ctx);
  assert.equal((await board()).conn?.budget, 2, "the spec left the conn alone");
  await handleSetBoardMode({ ...input, mode: "fullauto", agentId: "seat" }, ctx);
  assert.equal(sent.at(-1)?.[1], "Des switched this board to Full auto from the Progress page. Continue.");
  assert.equal((await board()).conn?.budget, 2);
});

test("setBoardMode still changes the board when there is nobody to ping or the ping fails, and says so", async (t) => {
  const w = await worktree(t);
  const input = { workspaceId: "ws", workspaceDirectory: w.directory };
  await runCli(["start", "Run"], { cwd: w.directory, workspaceId: "ws", now: () => minutes(0), out: () => {} });
  const quiet = { paseo: { agents: { ref: () => { throw new Error("must not send"); } } } as unknown as PluginHandlerContext["paseo"] };
  assert.deepEqual(await handleSetBoardMode({ ...input, mode: "clear" }, quiet), { mode: "clear", pinged: false, error: "No agent to tell." });
  const broken = { paseo: { agents: { ref: () => ({ send: async () => { throw new Error("daemon down"); } }) } } as unknown as PluginHandlerContext["paseo"] };
  const result = await handleSetBoardMode({ ...input, mode: "fullauto", agentId: "seat" }, broken);
  assert.deepEqual(result, { mode: "fullauto", pinged: false, error: "Could not tell the agent: daemon down" });
});

test("the hold sign and hover say which hold it is, and a held board keeps the auto-pullable mark on its objectives", () => {
  assert.equal(holdLabel({ on: true, kind: "closed", since: "x" }), "⏸️ Closed");
  assert.equal(holdLabel({ on: true, kind: "speccing", since: "x" }), "⏸️ Speccing");
  assert.match(holdHover({ on: true, kind: "closed", since: "x" }), /closed to work.*items can still be added/i);
  assert.match(holdHover({ on: true, kind: "speccing", note: "with Des", since: "x" }), /speccing with the owner.*with Des/i);
  const urgent = { id: "o1", status: "open", priority: 0 } as Ticket;
  assert.equal(isAutoPullable(urgent), true);
});

// o22 (Des, 15 Oct): "DEFAULT to repo unless public origin". Run history saves
// into the repo by default; a public origin keeps it local; a folder or an
// explicit off the user chose always wins.
test("an origin counts as public when it is on a public forge or cannot be told apart from one", () => {
  for (const url of [
    "https://github.com/desflynn/paseo-plugins.git",
    "git@github.com:desflynn/paseo-plugins.git",
    "ssh://git@github.com/desflynn/paseo-plugins.git",
    "https://user:token@GitHub.com/desflynn/x",
    "https://gitlab.com/x/y.git",
    "git@bitbucket.org:x/y.git",
    "https://www.github.com/x/y",
  ]) assert.equal(originIsPublic(url), true, url);
  for (const url of [null, "", "  ", "/srv/git/widgets.git", "file:///srv/git/widgets.git", "git@git.rvr.ie:team/widgets.git", "https://git.internal.example/team/widgets"]) {
    assert.equal(originIsPublic(url), false, String(url));
  }
});

test("run history saves to history/ by default when the repo has no public origin", async (t) => {
  for (const origin of [null, "git@git.rvr.ie:team/widgets.git"]) {
    const repo = await newRepo(t);
    await repo.setOrigin(origin);
    await repo.run(repo.directory, "start", "First run");
    const file = runFileName(minutes(0).toISOString(), "First run");
    assert.deepEqual(await repo.visible(), [`history/${file}`], `saved by default, origin ${origin}`);
    const result = await handleGetDashboard({ workspaceId: "ws-1", workspaceDirectory: repo.directory }, context);
    assert.ok("dashboard" in result);
    assert.equal(result.savedTo, "history", "the panel shows where it saves");
  }
});

test("a public origin keeps run history local, and a folder the user picked still wins", async (t) => {
  const repo = await newRepo(t);
  await repo.run(repo.directory, "start", "Local run");
  assert.deepEqual(await repo.visible(), [], "github origin: nothing written into the repo");
  const set = (folder: string | null) => handleSetHistoryFolder({ workspaceId: "ws-1", workspaceDirectory: repo.directory, folder }, context);
  assert.deepEqual(await set("notes"), { savedTo: "notes" });
  await repo.run(repo.directory, "activity", "add", "Now saved");
  assert.deepEqual(await repo.visible(), [`notes/${runFileName(minutes(0).toISOString(), "Local run")}`], "a chosen folder overrides the public origin");
});

test("stopping saving is remembered, and does not fall back to the default", async (t) => {
  const repo = await newRepo(t);
  await repo.setOrigin(null);
  const set = (folder: string | null) => handleSetHistoryFolder({ workspaceId: "ws-1", workspaceDirectory: repo.directory, folder }, context);
  assert.deepEqual(await set(null), { savedTo: null });
  await repo.run(repo.directory, "start", "Quiet run");
  assert.deepEqual(await repo.visible(), [], "explicitly off stays off with no origin");
  const result = await handleGetDashboard({ workspaceId: "ws-1", workspaceDirectory: repo.directory }, context);
  assert.ok("dashboard" in result);
  assert.equal(result.savedTo, null);
  assert.deepEqual(await set("history"), { savedTo: "history" }, "choosing a folder turns it back on");
  await repo.run(repo.directory, "activity", "add", "Saved again");
  assert.deepEqual(await repo.visible(), [`history/${runFileName(minutes(0).toISOString(), "Quiet run")}`]);
});

// Saved runs per workspace (HHC3 report, 15 Oct): the repo has one shared
// progress file, but each workspace's run is its own board. A saved file holds
// one workspace's run, complete from its run.start, and nothing of another's.
async function savedRuns(repo: { directory: string }) {
  const directory = join(repo.directory, "history");
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    events: (await readFile(join(directory, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; ws?: string; title?: string }),
  })));
}

test("each workspace's run is saved to its own file, complete from its run.start, with none of another's events", async (t) => {
  const repo = await newRepo(t);
  await repo.setOrigin(null);
  const as = (ws: string, ...argv: string[]) => repo.run(repo.directory, ...argv, "--workspace", ws);
  await as("wks_a", "start", "Alpha board");
  await as("wks_b", "start", "Beta board");
  await as("wks_a", "ticket", "add", "A one", "--estimate", "30");
  await as("wks_b", "ticket", "add", "B one", "--estimate", "30");
  await as("wks_a", "ticket", "add", "A two", "--estimate", "30");
  const saved = await savedRuns(repo);
  assert.equal(saved.length, 2, "one file per workspace run");
  const alpha = saved.find((run) => run.events[0].title === "Alpha board");
  const beta = saved.find((run) => run.events[0].title === "Beta board");
  assert.ok(alpha && beta);
  assert.equal(alpha.events[0].type, "run.start", "complete from its run.start");
  assert.deepEqual(alpha.events.filter((event) => event.type === "ticket.add").map((event) => event.title), ["A one", "A two"]);
  assert.ok(alpha.events.every((event) => event.ws === "wks_a"), "no event of another workspace");
  assert.deepEqual(beta.events.filter((event) => event.type === "ticket.add").map((event) => event.title), ["B one"]);
  assert.ok(beta.events.every((event) => event.ws === "wks_b"));
});

test("two workspaces whose runs would share a file name each keep a file of their own", async (t) => {
  const repo = await newRepo(t);
  await repo.setOrigin(null);
  const as = (ws: string, ...argv: string[]) => repo.run(repo.directory, ...argv, "--workspace", ws);
  await as("wks_a", "start", "Same board");
  await as("wks_b", "start", "Same board");
  await as("wks_a", "ticket", "add", "A one", "--estimate", "30");
  await as("wks_b", "ticket", "add", "B one", "--estimate", "30");
  const saved = await savedRuns(repo);
  assert.equal(saved.length, 2, "the second does not overwrite the first");
  for (const run of saved) {
    const owners = new Set(run.events.map((event) => event.ws));
    assert.equal(owners.size, 1, `${run.name} holds one workspace`);
    assert.equal(run.events.filter((event) => event.type === "ticket.add").length, 1);
  }
});

test("a saved file that already mixes workspaces heals on its workspace's next write", async (t) => {
  const repo = await newRepo(t);
  await repo.setOrigin(null);
  const as = (ws: string, ...argv: string[]) => repo.run(repo.directory, ...argv, "--workspace", ws);
  await as("wks_a", "start", "Alpha board");
  await as("wks_b", "start", "Beta board");
  await as("wks_b", "ticket", "add", "B one", "--estimate", "30");
  const name = runFileName(minutes(0).toISOString(), "Alpha board");
  const file = join(repo.directory, "history", name);
  const polluted = JSON.stringify({ v: 1, ts: minutes(0).toISOString(), type: "ticket.add", id: "o9", title: "Not mine", estimateMin: 5, ws: "wks_b" });
  await writeFile(file, `${(await readFile(file, "utf8")).trimEnd()}\n${polluted}\n`);
  await as("wks_a", "activity", "add", "After the pollution");
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(text, /Not mine/, "the other workspace's event is gone");
  assert.match(text, /After the pollution/);
});
