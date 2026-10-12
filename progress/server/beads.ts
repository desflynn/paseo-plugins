// The beads server side: one readonly `bd list` over the repo's recorded work,
// mapped onto the progress.beads contract. Beads stays the record; this reads
// it and never writes a third store. A fake runner stands in for the binary
// in tests.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { BeadDetail, BeadDetailResult, BeadIssue, BeadsResult, BeadStatus } from "../shared/rpc.ts";
import { getBeadDetail, getBeads, setBeadStatus, upgradeBead } from "../shared/rpc.ts";
import { runCli } from "./cli.ts";
import { findRoot } from "./paths.ts";

// Re-exported for existing imports; the type itself now lives in shared so
// the client bundle never imports this server-only module, even as a type.
export type { BeadsResult };

// The bd command runner, so tests can fake the binary.
export type BdRunner = (
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string }>;

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 5 * 1024 * 1024;

const defaultRunner: BdRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, maxBuffer: options.maxBuffer }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });

function issueOf(raw: unknown): BeadIssue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const { id, title, status } = record;
  if (typeof id !== "string" || typeof title !== "string" || typeof status !== "string") return null;
  const issue: BeadIssue = { id, title, status };
  if (typeof record.priority === "number") issue.priority = record.priority;
  if (typeof record.issue_type === "string") issue.issue_type = record.issue_type;
  if (typeof record.updated_at === "string") issue.updated_at = record.updated_at;
  if (typeof record.parent === "string") issue.parent = record.parent;
  return issue;
}

export async function readBeads(root: string, runner: BdRunner = defaultRunner): Promise<BeadsResult> {
  if (!existsSync(join(root, ".beads"))) return { state: "none" };
  let stdout: string;
  try {
    ({ stdout } = await runner("bd", ["--readonly", "-C", root, "list", "--json", "--limit", "0"], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    }));
  } catch (error) {
    // No bd on this machine is the calm empty state, not a fault to wave around.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "none" };
    const message = error instanceof Error ? error.message : String(error);
    return { state: "error", message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "error", message: "bd list printed something that is not JSON" };
  }
  if (!Array.isArray(parsed)) return { state: "error", message: "bd list printed no JSON array" };
  const issues = parsed.map(issueOf).filter((issue): issue is BeadIssue => issue !== null);
  // An empty read is ok with an empty list, not none (proof fix D-3): none
  // stays only for missing bd or no .beads/.
  return { state: "ok", issues };
}

export async function handleGetBeads(
  input: RpcInput<typeof getBeads>,
  _context: PluginHandlerContext,
  runner: BdRunner = defaultRunner,
): Promise<RpcOutput<typeof getBeads>> {
  return readBeads(findRoot(input.workspaceDirectory), runner);
}

// ── The bead detail sheet (T13 / O2200) ───────────────────────────────
// The sheet reads one bead's full record and writes its status back
// through bd's own verbs — `bd close --reason` closes, `bd update
// --status` moves the rest — and promotes through the existing
// ticket-add path with --ref bead:<id>. No third store, no invented flag.

function beadDetailOf(raw: unknown): BeadDetail | null {
  const base = issueOf(raw);
  if (!base) return null;
  const record = raw as Record<string, unknown>;
  const bead: BeadDetail = base;
  for (const field of ["description", "owner", "created_at", "created_by", "closed_at", "close_reason"] as const) {
    if (typeof record[field] === "string") bead[field] = record[field] as string;
  }
  return bead;
}

export async function readBeadDetail(root: string, id: string, runner: BdRunner = defaultRunner): Promise<BeadDetailResult> {
  if (!existsSync(join(root, ".beads"))) return { state: "none" };
  let stdout: string;
  try {
    ({ stdout } = await runner("bd", ["--readonly", "-C", root, "show", id, "--json"], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "none" };
    return { state: "error", message: error instanceof Error ? error.message : String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "error", message: "bd show printed something that is not JSON" };
  }
  if (Array.isArray(parsed)) {
    const raw = parsed.find((entry) => typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === id) ?? parsed[0];
    const bead = beadDetailOf(raw);
    return bead ? { state: "ok", bead } : { state: "error", message: `bd has no readable record for ${id}` };
  }
  // bd prints { error: "..." } for an unknown id; carry its own words.
  const message = typeof (parsed as { error?: unknown }).error === "string"
    ? (parsed as { error: string }).error
    : "bd show printed no JSON array";
  return { state: "error", message };
}

export async function handleGetBeadDetail(
  input: RpcInput<typeof getBeadDetail>,
  _context: PluginHandlerContext,
  runner: BdRunner = defaultRunner,
): Promise<RpcOutput<typeof getBeadDetail>> {
  return readBeadDetail(findRoot(input.workspaceDirectory), input.id, runner);
}

export async function writeBeadStatus(
  root: string,
  id: string,
  status: BeadStatus,
  reason?: string | null,
  runner: BdRunner = defaultRunner,
): Promise<{ state: "ok" } | { state: "none" } | { state: "error"; message: string }> {
  if (!existsSync(join(root, ".beads"))) return { state: "none" };
  const args = status === "closed"
    ? ["-C", root, "close", id, ...(reason ? ["--reason", reason] : [])]
    : ["-C", root, "update", id, "--status", status];
  try {
    await runner("bd", args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "none" };
    return { state: "error", message: error instanceof Error ? error.message : String(error) };
  }
  return { state: "ok" };
}

export async function handleSetBeadStatus(
  input: RpcInput<typeof setBeadStatus>,
  _context: PluginHandlerContext,
  runner: BdRunner = defaultRunner,
): Promise<RpcOutput<typeof setBeadStatus>> {
  return writeBeadStatus(findRoot(input.workspaceDirectory), input.id, input.status, input.reason, runner);
}

// The ticket-add side of the upgrade, injectable so tests never touch the
// real progress store.
// Closeout cascade, beads side (O2100): when an objective closes, its
// backing beads close with it, driven by the JSONL `bead:` refs. Only bead
// refs cascade here — GitHub closes later, on the GH leg of the objective.
// Fail soft: any bd fault — missing binary, spawn error, non-zero exit —
// comes back as a logged failure for the caller, never a throw, so a cascade
// fault can never fail the objective's own close. The agent persona stays
// the documented fallback: it notices an unclosed link and finishes the
// closeout itself.
export async function closeBackingBeads(
  root: string,
  refs: string[],
  reason: string,
  runner: BdRunner = defaultRunner,
): Promise<Array<{ id: string; message: string }>> {
  const failures: Array<{ id: string; message: string }> = [];
  for (const ref of refs) {
    if (!ref.startsWith("bead:")) continue;
    const id = ref.slice(5);
    try {
      await runner("bd", ["-C", root, "close", id, "--reason", reason], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    } catch (error) {
      failures.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}

export type ProgressCliRunner = (
  argv: string[],
  options: { cwd: string },
) => Promise<{ code: number; out: string[] }>;

const defaultCliRunner: ProgressCliRunner = async (argv, options) => {
  const out: string[] = [];
  const code = await runCli(argv, { cwd: options.cwd, out: (line) => out.push(line) });
  return { code, out };
};

// ticket add requires an estimate; an upgraded bead starts at an hour and
// the ticket's --ref bead:<id> keeps the link both ways.
const UPGRADE_ESTIMATE_MIN = 60;

export async function promoteBead(
  root: string,
  id: string,
  bdRunner: BdRunner = defaultRunner,
  cliRunner: ProgressCliRunner = defaultCliRunner,
): Promise<{ state: "ok"; ticketId: string | null } | { state: "none" } | { state: "error"; message: string }> {
  const detail = await readBeadDetail(root, id, bdRunner);
  if (detail.state !== "ok") return detail;
  let run: { code: number; out: string[] };
  try {
    run = await cliRunner(
      ["ticket", "add", detail.bead.title, "--estimate", String(UPGRADE_ESTIMATE_MIN), "--ref", `bead:${id}`],
      { cwd: root },
    );
  } catch (error) {
    return { state: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (run.code !== 0) {
    return { state: "error", message: run.out.join("\n").trim() || `paseo-progress exited ${run.code}` };
  }
  const ticketId = run.out.map((line) => /^Added (\S+):/.exec(line)?.[1]).find(Boolean) ?? null;
  return { state: "ok", ticketId };
}

export async function handleUpgradeBead(
  input: RpcInput<typeof upgradeBead>,
  _context: PluginHandlerContext,
  runner: BdRunner = defaultRunner,
  cliRunner: ProgressCliRunner = defaultCliRunner,
): Promise<RpcOutput<typeof upgradeBead>> {
  return promoteBead(findRoot(input.workspaceDirectory), input.id, runner, cliRunner);
}
