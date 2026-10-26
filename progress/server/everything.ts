import { execFile } from "node:child_process";
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
export const readHostBoards: HostReader = async (host) => {
  const { stdout } = await run(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", `des@${host.label}`, "paseo-progress show --all --json"],
    { timeout: 15_000, maxBuffer: 8 << 20 },
  );
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
