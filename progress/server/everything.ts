import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { summariseBoard, type BoardSummary } from "../shared/overview.ts";
import { collectHosts, type HostReader, type HostTarget } from "./collect.ts";

const run = promisify(execFile);

// Cache lives where the rest of the fleet's dci state lives, so it survives a
// plugin reload and a machine reboot.
export function cacheDirectory(): string {
  return join(homedir(), ".dci", "progress-cache");
}

// Where a host's boards come from. One Paseo host can hold more than one board:
// korolev has a KOR board and a DF board, in two worktrees inside one container.
// Targets come from ~/.dci/progress-hosts.json by Paseo label, as a string or a
// list of strings:
//   "des@100.98.165.77"                  -> ssh
//   "docker:korolev:/path/to/worktree"   -> docker exec -w <worktree>
// The -w flag is not optional for docker: without it the command runs in
// /workspace and returns a VALID document with an EMPTY board (KOR Guy, 25 Oct),
// which is indistinguishable from a dead host.
export type HostCommand = { bin: string; args: string[] };

function remote(dir?: string): string {
  const path = 'export PATH="$HOME/.local/bin:$PATH"';
  const show = "paseo-progress show --all --json";
  const body = dir ? `cd ${dir} && ${path} && ${show}` : `${path} && ${show}`;
  return `bash -lc '${body}'`;
}

export function hostTargets(label: string): string[] {
  try {
    const map = JSON.parse(readFileSync(join(homedir(), ".dci", "progress-hosts.json"), "utf8")) as Record<string, string | string[]>;
    const entry = map[label];
    if (Array.isArray(entry)) return entry.filter((value) => typeof value === "string" && value);
    if (typeof entry === "string" && entry) return [entry];
  } catch {
    // no map, or unreadable: fall through to the label
  }
  return [label];
}

// A target is one of:
//   docker:<container>:<worktree>   docker exec -w <worktree> <container>
//   <address>:<dir>                 ssh <address>, then cd <dir>
//   <address>                       ssh <address>
// The folder is not decoration. paseo-progress reads the board of the checkout it
// runs in. Run it in a home folder and it returns an empty board that looks valid.
export function hostCommand(target: string): HostCommand {
  if (target.startsWith("docker:")) {
    const [container, worktree] = target.slice("docker:".length).split(":");
    const args = ["exec"];
    if (worktree) args.push("-w", worktree);
    args.push(container!, remote());
    return { bin: "docker", args };
  }
  const at = target.indexOf("@");
  const colon = at >= 0 ? target.indexOf(":", at) : target.indexOf(":");
  const address = colon > 0 ? target.slice(0, colon) : target;
  const dir = colon > 0 ? target.slice(colon + 1) : undefined;
  return {
    bin: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", address.includes("@") ? address : `des@${address}`, remote(dir)],
  };
}

// Every target of a host is read; a target that fails contributes nothing and
// never fails its siblings. Empty board documents are dropped: a host that
// answers with no objectives is a mis-run, not a result worth showing.
export const readHostBoards: HostReader = async (host) => {
  const boards: Record<string, BoardSummary | null> = {};
  const targets = hostTargets(host.label);
  const settled = await Promise.allSettled(
    targets.map(async (target) => {
      const { bin, args } = hostCommand(target);
      const { stdout } = await run(bin, args, { timeout: 20_000, maxBuffer: 8 << 20 });
      return summariseBoard((JSON.parse(stdout) as { dashboard?: unknown }).dashboard as never);
    }),
  );
  settled.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) boards[`host:${host.serverId}:${index}`] = result.value;
  });
  if (!Object.keys(boards).length) throw new Error(`no boards read for ${host.label}`);
  return boards;
};

// The Everything call: every configured host, live where possible, cached where
// not. Never throws for one dead host; `collectHosts` owns that.
export async function handleGetAllHostsOverview(input: { hosts: HostTarget[] }) {
  const hosts = await collectHosts(input.hosts, readHostBoards, cacheDirectory(), new Date().toISOString());
  return { hosts };
}
