import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BoardSummary } from "../shared/overview.ts";
import { collectHosts, type HostReader, type HostTarget } from "./collect.ts";
import { shortLabel } from "../shared/machine.ts";

const run = promisify(execFile);

// Cache lives where the rest of the fleet's dci state lives, so it survives a
// plugin reload and a machine reboot.
export function cacheDirectory(): string {
  return join(homedir(), ".dci", "progress-cache");
}

export type HostCommand = { bin: string; args: string[] };

// Which machine answers for a label. A label maps to one address in
// ~/.dci/progress-hosts.json, either "des@host" or "docker:<container>".
// The panel sends the short label it renders (KLV), while the map is keyed by
// machine name (korolev), so a name and its short form both have to resolve.
export function resolveTarget(map: Record<string, string | string[]>, label: string): string[] {
  const byShort = Object.keys(map).find((key) => shortLabel(key) === label.trim().toUpperCase());
  const entry = map[label] ?? map[label.toLowerCase()] ?? (byShort ? map[byShort] : undefined);
  if (Array.isArray(entry)) return entry.filter((value) => typeof value === "string" && value);
  if (typeof entry === "string" && entry) return [entry];
  return [label];
}

export function hostTargets(label: string): string[] {
  try {
    const map = JSON.parse(readFileSync(join(homedir(), ".dci", "progress-hosts.json"), "utf8")) as Record<string, string | string[]>;
    return resolveTarget(map, label);
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

// One store folder is one board. A host may list the same store once per
// workspace that shares it, so the folder is the identity and duplicates fold
// together; this box has 119 workspaces over 37 cwds and 17 real boards.
export function foldBoards(payload: BoardPayload): Record<string, BoardSummary | null> {
  const boards: Record<string, BoardSummary | null> = {};
  for (const board of payload.boards ?? []) {
    const key = board.directory ?? board.cwd;
    if (key && board.summary && !(key in boards)) boards[key] = board.summary;
  }
  return boards;
}

// A host that answers with no boards is a failure, not a result: it falls to the
// cache so the strip never claims a live machine has nothing on it.
export interface HostReaderDeps {
  fetch?: typeof globalThis.fetch;
  run?: (bin: string, args: string[]) => Promise<{ stdout: string }>;
  token?: string;
  port?: number;
}

// The harness endpoint the fleet is being rolled onto. It answers the same JSON
// paseo-boards prints, so nothing needs translating.
export function boardsPort(): number {
  const raw = Number(process.env.DCI_BOARDS_PORT ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 8770;
}

// One shared token, from the environment first so a test or a shell can override
// it, then the file the harness installer writes.
export function boardsToken(): string {
  const fromEnv = process.env.DCI_BOARDS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(homedir(), ".dci", "boards-token"), "utf8").trim();
  } catch {
    return "";
  }
}

// A docker target is reached through the docker socket, not the network.
export function boardsEndpoint(target: string, port = boardsPort()): string | null {
  if (target.startsWith("docker:")) return null;
  const host = target.includes("@") ? target.slice(target.indexOf("@") + 1) : target;
  return host ? `http://${host}:${port}` : null;
}

export function makeHostReader(deps: HostReaderDeps = {}): HostReader {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const exec = deps.run ?? ((bin: string, args: string[]) => run(bin, args, { timeout: 20_000, maxBuffer: 8 << 20 }));
  return async (host) => {
    const target = hostTargets(host.label)[0]!;
    const token = deps.token ?? boardsToken();
    const base = boardsEndpoint(target, deps.port);
    if (base && token) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetchImpl(`${base}/v1/boards`, {
          headers: { "x-dci-token": token },
          signal: controller.signal,
        });
        if (res.ok) {
          const boards = foldBoards((await res.json()) as BoardPayload);
          if (Object.keys(boards).length) return boards;
        }
      } catch {
        // Unreachable, refused or unauthorised: the shell path below still runs.
      } finally {
        clearTimeout(timer);
      }
    }
    const { bin, args } = hostCommand(target);
    const { stdout } = await exec(bin, args);
    const boards = foldBoards(JSON.parse(stdout) as BoardPayload);
    if (!Object.keys(boards).length) throw new Error(`no boards read for ${host.label}`);
    return boards;
  };
}

export const readHostBoards: HostReader = makeHostReader();

// The Everything call: every configured host, live where possible, cached where
// not. One dead machine never fails the page.
export async function handleGetAllHostsOverview(input: { hosts: HostTarget[] }) {
  const hosts = await collectHosts(input.hosts, readHostBoards, cacheDirectory(), new Date().toISOString());
  return { hosts };
}
