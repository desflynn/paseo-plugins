import type { BoardSummary } from "../shared/overview.ts";
import { fallbackSnapshot, writeSnapshot, type HostSnapshot } from "./hosts.ts";

// A host as the Everything view knows it. `status` mirrors Paseo's own
// online/offline/error so an unreachable box still renders a row.
export interface HostTarget {
  serverId: string;
  label: string;
  status: string;
}

// Reads one host's boards. The live implementation shells `paseo-progress
// show --all --json` over ssh; tests pass a fake.
export type HostReader = (host: HostTarget) => Promise<Record<string, BoardSummary | null>>;

// Every host, read in parallel, one failure never taking the page down: a host
// that throws contributes its cached snapshot, marked stale. `now` is injected
// so the caller owns the clock.
export async function collectHosts(
  targets: readonly HostTarget[],
  read: HostReader,
  cacheDirectory: string,
  now: string,
): Promise<HostSnapshot[]> {
  const settled = await Promise.allSettled(
    targets.map(async (host): Promise<HostSnapshot> => {
      const boards = await read(host);
      return { serverId: host.serverId, label: host.label, status: host.status, boards, at: now, stale: false };
    }),
  );

  return settled.map((result, index) => {
    const host = targets[index]!;
    if (result.status === "fulfilled") {
      writeSnapshot(cacheDirectory, result.value);
      return result.value;
    }
    return fallbackSnapshot(cacheDirectory, host, now);
  });
}
