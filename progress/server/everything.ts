import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BoardSummary } from "../shared/overview.ts";
import { collectHosts, type HostReader, type HostTarget } from "./collect.ts";

const run = promisify(execFile);

// Cache lives where the rest of the fleet's dci state lives, so it survives a
// plugin reload and a machine reboot.
export function cacheDirectory(): string {
  return join(homedir(), ".dci", "progress-cache");
}

export type HostCommand = { bin: string; args: string[] };

// Which machine answers for a label. A label maps to one address in
// ~/.dci/progress-hosts.json, either "des@host" or "docker:<container>".
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

// One command per machine. `paseo-boards` sits on the bin path there and returns
// every in-repo board in one JSON document:
//   {"machine":"<host>","at":"<iso>","boards":[{"cwd","title","directory","summary"}]}
// It does what this plugin does on its own host: ask that host's Paseo for its
// workspaces, then fold each workspace's board. No repo path, no crawl, and no
// per-repo subprocess, so a machine costs one round trip.
const BOARDS_COMMAND = "bash -lc 'export PATH=\"$HOME/.local/bin:$PATH\"; paseo-boards'";

export function hostCommand(target: string): HostCommand {
  if (target.startsWith("docker:")) {
    return { bin: "docker", args: ["exec", target.slice("docker:".length), BOARDS_COMMAND] };
  }
  const address = target.includes("@") ? target : `des@${target}`;
  return { bin: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", address, BOARDS_COMMAND] };
}

// A host that answers with no boards is a failure, not a result: it falls to the
// cache so the strip never claims a live machine has nothing on it.
export const readHostBoards: HostReader = async (host) => {
  const { bin, args } = hostCommand(hostTargets(host.label)[0]!);
  const { stdout } = await run(bin, args, { timeout: 20_000, maxBuffer: 8 << 20 });
  const payload = JSON.parse(stdout) as { boards?: Array<{ cwd?: string; summary?: BoardSummary }> };
  const boards: Record<string, BoardSummary | null> = {};
  for (const board of payload.boards ?? []) {
    if (board.cwd && board.summary) boards[board.cwd] = board.summary;
  }
  if (!Object.keys(boards).length) throw new Error(`no boards read for ${host.label}`);
  return boards;
};

// The Everything call: every configured host, live where possible, cached where
// not. One dead machine never fails the page.
export async function handleGetAllHostsOverview(input: { hosts: HostTarget[] }) {
  const hosts = await collectHosts(input.hosts, readHostBoards, cacheDirectory(), new Date().toISOString());
  return { hosts };
}
