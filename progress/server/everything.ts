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
const BOARDS_SCRIPT = "export PATH=\"$HOME/.local/bin:$PATH\"; paseo-boards";
// ssh rejoins its arguments for a remote shell, so that side keeps the quoted line.
const BOARDS_COMMAND = `bash -lc '${BOARDS_SCRIPT}'`;

export function hostCommand(target: string): HostCommand {
  if (target.startsWith("docker:")) {
    // docker exec takes argv, not a shell line: a quoted script reaches bash with
    // its quotes still on and the helper never runs, so the host looks dead.
    return { bin: "docker", args: ["exec", target.slice("docker:".length), "bash", "-lc", BOARDS_SCRIPT] };
  }
  const address = target.includes("@") ? target : `des@${target}`;
  return { bin: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", address, BOARDS_COMMAND] };
}

export interface BoardPayload {
  boards?: Array<{ cwd?: string; directory?: string; title?: string; summary?: BoardSummary }>;
}

// A state folder holds one board per workspace: this box has 17 folders and 92
// boards, so the folder alone is not an identity. The title is the only field the
// helper sends that separates the boards in one folder, so the key is both.
export function foldBoards(payload: BoardPayload): Record<string, BoardSummary | null> {
  const boards: Record<string, BoardSummary | null> = {};
  for (const board of payload.boards ?? []) {
    const folder = board.directory ?? board.cwd;
    if (!folder || !board.summary) continue;
    boards[`${folder}::${board.title ?? ""}`] = board.summary;
  }
  return boards;
}

// A host that answers with no boards is a failure, not a result: it falls to the
// cache so the strip never claims a live machine has nothing on it.
export const readHostBoards: HostReader = async (host) => {
  const { bin, args } = hostCommand(hostTargets(host.label)[0]!);
  const { stdout } = await run(bin, args, { timeout: 20_000, maxBuffer: 8 << 20 });
  const boards = foldBoards(JSON.parse(stdout) as BoardPayload);
  if (!Object.keys(boards).length) throw new Error(`no boards read for ${host.label}`);
  return boards;
};

// The Everything call: every configured host, live where possible, cached where
// not. One dead machine never fails the page.
export async function handleGetAllHostsOverview(input: { hosts: HostTarget[] }) {
  const hosts = await collectHosts(input.hosts, readHostBoards, cacheDirectory(), new Date().toISOString());
  return { hosts };
}
