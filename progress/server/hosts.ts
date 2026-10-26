import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardSummary } from "../shared/overview";
import { shortLabel } from "../shared/machine.ts";
export { shortLabel };

// One host's board data as the Everything view sees it. `stale` marks a
// snapshot served from cache because the host could not be read this time.
export interface HostSnapshot {
  serverId: string;
  label: string;
  status: string;
  boards: Record<string, BoardSummary | null>;
  at: string;
  stale: boolean;
}

// HostSnapshot carries the machine tag beside an objective; the tag itself
// lives in shared/machine.ts so the client renders the same letters.

function cachePath(directory: string, serverId: string): string {
  return join(directory, `${serverId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

// A snapshot is only worth keeping if it carries at least one board; an empty
// read is almost always a broken host, and must never overwrite a good cache.
export function isWorthCaching(snapshot: HostSnapshot): boolean {
  return Object.keys(snapshot.boards).length > 0;
}

export function writeSnapshot(directory: string, snapshot: HostSnapshot): void {
  if (!isWorthCaching(snapshot)) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(cachePath(directory, snapshot.serverId), JSON.stringify({ ...snapshot, stale: false }), "utf8");
}

// The cached snapshot for a host, marked stale, or null when there is none or
// the file is unreadable. A cache read never throws: an offline host with no
// cache simply contributes nothing.
export function readCachedSnapshot(directory: string, serverId: string): HostSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(directory, serverId), "utf8")) as HostSnapshot;
    if (!raw || typeof raw !== "object" || typeof raw.boards !== "object" || raw.boards === null) return null;
    return { ...raw, stale: true };
  } catch {
    return null;
  }
}

// Live read failed: serve the cache if we have one, otherwise a bare offline
// row so the view can still say "this machine exists and we could not read it".
export function fallbackSnapshot(
  directory: string,
  host: { serverId: string; label: string; status: string },
  now: string,
): HostSnapshot {
  const cached = readCachedSnapshot(directory, host.serverId);
  if (cached) return cached;
  return { serverId: host.serverId, label: host.label, status: host.status, boards: {}, at: now, stale: true };
}
