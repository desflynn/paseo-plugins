import type { usePaseo } from "@getpaseo/plugin/client";
import { workspaceOwner, type AgentRow } from "../shared/modes";
import type { AgentRef } from "../shared/overview";

export type Paseo = ReturnType<typeof usePaseo>;
export type Page = { entries: unknown[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } };

// Every page of a directory listing, not just the first.
export async function listAll(list: (options?: { page?: { cursor: string; limit: number } }) => Promise<Page>): Promise<unknown[]> {
  const entries: unknown[] = [];
  let page = await list();
  entries.push(...page.entries);
  while (page.pageInfo.hasMore && page.pageInfo.nextCursor) {
    page = await list({ page: { cursor: page.pageInfo.nextCursor, limit: 100 } });
    entries.push(...page.entries);
  }
  return entries;
}

// The seat that owns a workspace's board, read when asked (a tap), not on a timer.
export async function loadWorkspaceOwner(paseo: Paseo, workspaceId: string): Promise<AgentRef | null> {
  const rows = await listAll((options) => paseo.agents.list({ ...options, filter: { includeArchived: false } }) as Promise<Page>);
  return workspaceOwner(rows as AgentRow[], workspaceId);
}
