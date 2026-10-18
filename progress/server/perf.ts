// Evidence for the panel's freezes (o24): the client reports each stall here
// and the lines are appended to one plain log the maintainer reads. It sits
// beside the board stores, not inside them, and it must never break the panel,
// so every fault is swallowed.
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PERF_LOG_MAX_BYTES = 2_000_000;

export function perfLogPath(env: { PASEO_PROGRESS_PERF_LOG?: string } = process.env): string {
  return env.PASEO_PROGRESS_PERF_LOG || join(homedir(), ".local", "state", "paseo-progress-perf.log");
}

export async function handleReportPerf(
  input: { lines: string[] },
  _context: PluginHandlerContext,
  log: string = perfLogPath(),
  maxBytes: number = PERF_LOG_MAX_BYTES,
) {
  try {
    const size = await stat(log).then((info) => info.size, () => 0);
    await mkdir(dirname(log), { recursive: true });
    // Past the cap, keep the newest lines that fit and cut on a line start, so
    // the watcher never goes blind (o47).
    if (size >= maxBytes) {
      const text = await readFile(log, "utf8");
      const tail = text.slice(-Math.floor(maxBytes / 2));
      const cut = tail.indexOf("\n");
      await writeFile(log, cut >= 0 ? tail.slice(cut + 1) : "");
    }
    await appendFile(log, input.lines.map((line) => `${line}\n`).join(""));
  } catch {
    // Instrumentation is best effort.
  }
  return {};
}
