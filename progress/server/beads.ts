// The beads server side: one readonly `bd list` over the repo's recorded work,
// mapped onto the progress.beads contract. Beads stays the record; this reads
// it and never writes a third store. A fake runner stands in for the binary
// in tests.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { BeadIssue, BeadsResult } from "../shared/rpc.ts";
import { getBeads } from "../shared/rpc.ts";
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
