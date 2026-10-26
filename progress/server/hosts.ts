import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardSummary } from "../shared/overview";

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

// The machine tag Des wants beside an objective: a short, stable name. Paseo
// host labels are "korolev", "dgx-spark", "ideapad", so the first three
// letters give KOR, DGX, IDE. Rename a host in Paseo and the tag follows.
export function shortLabel(label: string): string {
  const letters = label.replace(/[^A-Za-z0-9]/g, "");
  if (!letters) return "?";
  return letters.slice(0, 3).toUpperCase();
}

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
