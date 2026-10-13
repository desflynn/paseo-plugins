import { useRpc } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type DashboardResult, getDashboard } from "../shared/rpc.ts";
import { mark } from "./perf.ts";

type DashboardScope = "workspace" | "all";
type FetchDashboard = (input: { workspaceId: string; workspaceDirectory: string; since?: string; scope?: DashboardScope }) => Promise<RpcOutput<typeof getDashboard>>;

export const POLL_MS = 3_000;

// `previous` is what the cache already holds. Polls send its version, and an
// "unchanged" reply keeps that same object, so nothing re-renders.
export function dashboardQueryOptions(fetchDashboard: FetchDashboard, hostId: string, workspaceId: string, directory: string | null, previous?: () => DashboardResult | undefined, scope: DashboardScope = "workspace", visible = true) {
  // A hidden panel stops polling: views the host keeps mounted after
  // navigation must not stack round trips (o24 follow-up).
  const refetchInterval: number | false = visible ? POLL_MS : false;
  return {
    queryKey: ["progress", "dashboard", hostId, workspaceId, directory, scope],
    queryFn: async (): Promise<DashboardResult> => {
      const last = previous?.();
      const startedAt = Date.now();
      const result = await fetchDashboard({ workspaceId, workspaceDirectory: directory!, ...(last ? { since: last.version } : {}), scope });
      mark(`dashboard poll ${Date.now() - startedAt}ms ${"unchanged" in result && last ? "unchanged" : "changed"}`);
      return "unchanged" in result && last ? last : result as DashboardResult;
    },
    enabled: Boolean(directory),
    staleTime: POLL_MS,
    refetchInterval,
  };
}

export function useDashboard(hostId: string, workspaceId: string, directory: string | null, scope: DashboardScope = "workspace", visible = true) {
  const fetchDashboard = useRpc(getDashboard);
  const queryClient = useQueryClient();
  const options = dashboardQueryOptions(fetchDashboard, hostId, workspaceId, directory,
    () => queryClient.getQueryData<DashboardResult>(options.queryKey), scope, visible);
  return useQuery(options);
}
