import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { summariseBoard } from "../shared/overview.ts";
import { collectHosts, type HostReader, type HostTarget } from "./collect.ts";

const run = promisify(execFile);

// Cache lives where the rest of the fleet's dci state lives, so it survives a
// plugin reload and a machine reboot.
export function cacheDirectory(): string {
  return join(homedir(), ".dci", "progress-cache");
}

// Reads one host's board over ssh. The fleet addresses hosts as `des@<label>`
// and `paseo-progress` is on PATH there, so the target needs no new config.
// The union board from `show --all` is stored under `host:<serverId>`: the
// Everything view sums these, it does not need per-workspace keys.
// Reads one host's board over ssh. The target comes from ~/.dci/progress-hosts.json
// when that file maps a Paseo label to an ssh target (korolev and ideapad have no
// ssh alias here), otherwise the label is used as-is. The command runs through a
// login shell with the local bin on PATH, because `paseo-progress` lives in
// ~/.local/bin and a non-interactive ssh session does not see it.
function sshTarget(label: string): string {
  try {
    const map = JSON.parse(readFileSync(join(homedir(), ".dci", "progress-hosts.json"), "utf8")) as Record<string, string>;
    if (typeof map[label] === "string" && map[label]) return map[label];
  } catch {
    // no map, or unreadable: fall through to the label
  }
  return `des@${label}`;
}

const REMOTE_COMMAND = "bash -lc 'export PATH=\"$HOME/.local/bin:$PATH\"; paseo-progress show --all --json'";

export const readHostBoards: HostReader = async (host) => {
  const { stdout } = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", sshTarget(host.label), REMOTE_COMMAND], {
    timeout: 20_000,
    maxBuffer: 8 << 20,
  });
  const payload = JSON.parse(stdout) as { dashboard?: unknown };
  const summary = summariseBoard(payload.dashboard as never);
  return summary ? { [`host:${host.serverId}`]: summary } : {};
};

// The Everything call: every configured host, live where possible, cached where
// not. Never throws for one dead host; `collectHosts` owns that.
export async function handleGetAllHostsOverview(input: { hosts: HostTarget[] }) {
  const hosts = await collectHosts(input.hosts, readHostBoards, cacheDirectory(), new Date().toISOString());
  return { hosts };
}
