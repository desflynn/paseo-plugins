import { type PluginScreenProps, type PluginSidebarItemProps, useRpc, usePaseo } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import type { RpcOutput } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { formatAgo } from "../shared/format";
import { archivedFor, buildSections, plainName, type ArchivedAgent, cardCount, chatsSpan, gridLayout, groupOverview, headerCounts, headerLine, packRepos, pageFeed, repoSpan, repoSummary, spanWidth, splitGroup, type AgentRef, type ProjectGroup, type WorkspaceRef } from "../shared/overview";
import { getOverview } from "../shared/rpc";
import { listAll, loadWorkspaceOwner, type Page, type Paseo } from "./agents-list";
import { POLL_MS } from "./dashboard-query";
import { BoardCard, ChatsCard, isHovered } from "./overview-card";

// o36, o38: the Progress page. Every board, agent and full auto across all
// workspaces, grouped by repo into Active, Idle and Quiet. The rules are pure
// and tested in shared/overview.ts; the card is client/overview-card.tsx; this
// is the data and the page.

export const PROGRESS_SCREEN_ID = "progress-all";

type Colors = PluginScreenProps["theme"]["colors"];

type WorkspaceEntryPayload = { id: string; projectId: string; projectDisplayName?: string; projectRootPath: string; name: string; title?: string | null; workspaceDirectory?: string; labels?: string[] };
type AgentPayload = { id: string; workspaceId?: string | null; status: AgentRef["status"]; title?: string | null; parentAgentId?: string | null };

type FetchOverview = (input: { workspaces: { workspaceId: string; workspaceDirectory: string }[] }) => Promise<RpcOutput<typeof getOverview>>;

async function loadOverview(paseo: Paseo, fetchOverview: FetchOverview): Promise<ProjectGroup[]> {
  const [rawWorkspaces, rawAgents] = await Promise.all([
    listAll((options) => paseo.workspaces.list(options) as Promise<Page>),
    listAll((options) => paseo.agents.list({ ...options, filter: { includeArchived: false } }) as Promise<Page>),
  ]);
  const workspaces: WorkspaceRef[] = (rawWorkspaces as WorkspaceEntryPayload[]).map((workspace) => ({
    id: workspace.id,
    projectId: workspace.projectId,
    projectName: workspace.projectDisplayName ?? workspace.projectRootPath,
    projectPath: workspace.projectRootPath,
    name: workspace.title ?? workspace.name,
    directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
    ...(workspace.labels?.length ? { labels: workspace.labels } : {}),
  }));
  const agents: AgentRef[] = (rawAgents as { agent: AgentPayload }[]).flatMap(({ agent }) =>
    agent.workspaceId ? [{ id: agent.id, workspaceId: agent.workspaceId, status: agent.status, title: agent.title ?? null, parentAgentId: agent.parentAgentId ?? null }] : []);
  const { boards } = await fetchOverview({ workspaces: workspaces.map((workspace) => ({ workspaceId: workspace.id, workspaceDirectory: workspace.directory })) });
  return groupOverview(workspaces, boards, agents);
}

// o38.4: every archived agent, read only when the list is opened. Paseo cannot restore one, but an archived agent still opens to chat.
async function loadArchived(paseo: Paseo): Promise<ArchivedAgent[]> {
  const raw = await listAll((options) => paseo.agents.list({ ...options, filter: { includeArchived: true } }) as Promise<Page>);
  return (raw as { agent: { id: string; title?: string | null; cwd?: string; archivedAt?: string | null } }[]).flatMap(({ agent }) =>
    agent.archivedAt && agent.cwd ? [{ id: agent.id, title: agent.title ?? null, cwd: agent.cwd, archivedAt: agent.archivedAt }] : []);
}

function useOverview(hostId: string) {
  const paseo = usePaseo();
  const fetchOverview = useRpc(getOverview);
  return useQuery({
    queryKey: ["progress", "overview", hostId],
    queryFn: () => loadOverview(paseo, fetchOverview),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });
}

const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" } as const;

const GAP = 12;

function Chevron({ colors, open, size = 14 }: { colors: Colors; open: boolean; size?: number }) {
  return <Icon name={open ? "ChevronDown" : "ChevronRight"} size={size} color={colors.foregroundMuted} />;
}

// A repo that shares its row ends in a thick light-grey rule, so it is clear where it stops.
const DIVIDER = 8;

// The repo header's "View archived agents": a list of this repo's archived agents; pick one to chat with it.
function ArchivedButton({ colors, group, now, navigation, hostId }: { colors: Colors; group: ProjectGroup; now: number; navigation: PluginScreenProps["navigation"]; hostId: string }) {
  const paseo = usePaseo();
  const [open, setOpen] = useState(false);
  const archived = useQuery({ queryKey: ["progress", "archived", hostId], queryFn: () => loadArchived(paseo), enabled: open, staleTime: 15_000 });
  const rows = archivedFor(group, archived.data ?? []);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="View archived agents" {...({ title: "View archived agents" } as object)} onPress={() => setOpen(true)}
        style={(state) => ({ padding: 4, borderRadius: 4, backgroundColor: isHovered(state) ? colors.surface2 : "transparent" })}>
        <Icon name="Archive" size={14} color={colors.foregroundMuted} />
      </Pressable>
      <Modal title={`Archived agents · ${group.projectName}`} icon={<Icon name="Archive" size={16} color={colors.foregroundMuted} />} open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Archived agents cannot be restored, but you can still chat with one.</Text>
          {archived.isLoading ? <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>Loading…</Text>
            : !rows.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>No archived agents in this repo.</Text>
            : (
              <ScrollView style={{ maxHeight: 360 }}>
                {rows.map((agent) => (
                  <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`Open archived agent ${agent.title ?? agent.id}`} disabled={!navigation?.openAgent}
                    onPress={() => { setOpen(false); navigation?.openAgent({ agentId: agent.id, serverId: hostId }); }}
                    style={(state) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, backgroundColor: isHovered(state) ? colors.surface2 : "transparent" })}>
                    <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{plainName(agent.title ?? agent.id)}</Text>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{formatAgo(agent.archivedAt, now)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
        </Modal.Content>
      </Modal>
    </>
  );
}

function RepoBlock({ colors, group, folded, onToggle, span, columns, cardWidth, shared, now, navigation, hostId }: {
  colors: Colors; group: ProjectGroup; folded: boolean; onToggle(): void; span: number; columns: number; cardWidth: number; shared: boolean;
  now: number; navigation: PluginScreenProps["navigation"]; hostId: string;
}) {
  const { boards, chats } = splitGroup(group);
  // A repo that does not fill its row ends in a rule, shared with another repo or not.
  const ruled = span < columns;
  const blockWidth = spanWidth(span, cardWidth, GAP);
  const inner = ruled ? blockWidth - DIVIDER : blockWidth;
  // In a shared row the repo is `span` columns wide; alone it uses the page's columns.
  const cols = ruled ? span : columns;
  const cw = ruled ? Math.floor((inner - (span - 1) * GAP) / span) : cardWidth;
  const cards: { node: React.ReactNode; width: number }[] = boards.map((entry) => ({
    node: <BoardCard key={entry.workspace.id} colors={colors} entry={entry} repoName={group.projectName} now={now} navigation={navigation} hostId={hostId} />,
    width: cw,
  }));
  if (chats.length) cards.push({ node: <ChatsCard key="chats" colors={colors} entries={chats} navigation={navigation} hostId={hostId} />, width: chatsSpan(cols, boards.length) === "full" ? inner - 1 : cw });
  return (
    <View style={{ width: blockWidth, flexDirection: "row", alignItems: "stretch" }}>
      <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: !folded }} onPress={onToggle}
          style={(state) => ({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, paddingVertical: 6, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 6, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: isHovered(state) ? colors.surface1 : "transparent" })}>
          <Chevron colors={colors} open={!folded} />
          <Text style={{ color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>{group.projectName}</Text>
          {group.projectPath ? <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, ...mono }}>{group.projectPath}</Text> : null}
          {shared ? null : <View style={{ flex: 1 }} />}
          {shared ? null : <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{repoSummary(group)}</Text>}
          <ArchivedButton colors={colors} group={group} now={now} navigation={navigation} hostId={hostId} />
        </Pressable>
        {folded ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP, alignItems: "flex-start" }}>
            {cards.map((card, index) => <View key={index} style={{ width: card.width }}>{card.node}</View>)}
          </View>
        )}
      </View>
      {ruled ? <View accessibilityLabel="End of this repo" style={{ width: DIVIDER / 2, marginLeft: DIVIDER / 2, borderRadius: 2, backgroundColor: colors.foregroundMuted, opacity: 0.5 }} /> : null}
    </View>
  );
}

// One section's repos. The section measures itself, then repos fill its rows in
// order: 1-1-1, 1-2 or 2-1 cards across (never 1-3). A folded repo is only a
// header, so it takes a whole row.
function SectionRepos({ colors, groups, isFolded, flip, now, navigation, hostId }: {
  colors: Colors; groups: ProjectGroup[]; isFolded(group: ProjectGroup): boolean; flip(key: string): void; now: number; navigation: PluginScreenProps["navigation"]; hostId: string;
}) {
  const [width, setWidth] = useState(0);
  const { columns, cardWidth } = gridLayout(width, GAP);
  const spans = groups.map((group) => (isFolded(group) ? columns : repoSpan(cardCount(group), columns)));
  const rows = width > 0 ? packRepos(spans, columns) : [];
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ gap: 20 }}>
      {rows.map((row) => (
        <View key={row.map((index) => groups[index].projectId).join("|")} style={{ flexDirection: "row", gap: GAP, alignItems: "flex-start" }}>
          {row.map((index) => (
            <RepoBlock key={groups[index].projectId} colors={colors} group={groups[index]} folded={isFolded(groups[index])} onToggle={() => flip(`repo:${groups[index].projectId}`)}
              span={spans[index]} columns={columns} cardWidth={cardWidth} shared={row.length > 1} now={now} navigation={navigation} hostId={hostId} />
          ))}
        </View>
      ))}
    </View>
  );
}

// Des, 19 Oct (o52): the fleet's objective log at the top of the page — the
// work happening now and what has completed, working rows in white and
// completed rows in green, with the rest of the history behind one More info.
// Open by default here; the workspace panel keeps its copy closed.
function PageFeed({ colors, groups, now, navigation }: { colors: Colors; groups: ProjectGroup[]; now: number; navigation: PluginScreenProps["navigation"] }) {
  const feed = pageFeed(groups);
  const [full, setFull] = useState(false);
  const [open, setOpen] = useState(true);
  const [owners, setOwners] = useState<Record<string, { id: string; name: string }>>({});
  const paseo = usePaseo();
  const single = useWindowDimensions().width >= 700;
  const workspaces = feed.changes.map((row) => row.workspaceId).join(",");
  useEffect(() => {
    let alive = true;
    const ids = [...new Set(workspaces.split(",").filter(Boolean))];
    void (async () => {
      const found: Record<string, { id: string; name: string }> = {};
      for (const id of ids) {
        try {
          const owner = await loadWorkspaceOwner(paseo, id);
          if (owner) found[id] = { id: owner.id, name: plainName(owner.title ?? "Agent") };
        } catch { /* no owner known yet */ }
      }
      if (alive) setOwners(found);
    })();
    return () => { alive = false; };
  }, [workspaces, paseo]);
  if (!feed.changes.length) return null;
  const rows = full ? feed.changes : feed.changes.slice(0, 7);
  return (
    <View style={{ marginHorizontal: 16, marginTop: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: "hidden" }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
        style={{ paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.surface1, borderBottomWidth: open ? 1 : 0, borderBottomColor: colors.border }}>
        <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>Feed</Text>
      </Pressable>
      {open ? <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 4 }}>
        {rows.map((row) => {
          const done = row.what === "Completed";
          const owner = owners[row.workspaceId];
          return (
            <Pressable key={`${row.workspaceId}:${row.id}:${row.at}`} accessibilityRole="button" onPress={() => { if (owner) navigation?.openAgent({ agentId: owner.id }); }}>
              <Text numberOfLines={single ? 1 : undefined} style={{ fontSize: 13, lineHeight: 18 }}>
                <Text style={{ color: colors.foregroundMuted }}>{formatAgo(row.at, now)} · {row.board} · </Text>
                <Text style={{ color: done ? colors.statusSuccess : colors.foreground }}>{row.title}</Text>
                <Text style={{ color: colors.foregroundMuted }}> · P{row.priority} · </Text>
                <Text style={{ color: done ? colors.statusSuccess : colors.foreground }}>{row.what}</Text>
                {owner ? <Text style={{ color: colors.foregroundMuted }}> · {owner.name}</Text> : null}
              </Text>
            </Pressable>
          );
        })}
        {feed.changes.length > 7 ? (
          <Pressable accessibilityRole="button" onPress={() => setFull(!full)}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{full ? "Show less" : `More info (${feed.changes.length})`}</Text>
          </Pressable>
        ) : null}
      </View> : null}
    </View>
  );
}

export function ProgressOverviewScreen({ theme, host, navigation }: PluginScreenProps) {
  const { colors } = theme;
  const { data: groups, error, isLoading } = useOverview(host.id);
  const now = Date.now();
  // Sections and repos the viewer has flipped; the rest keep their default.
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const flip = (key: string) => setFlipped((current) => ({ ...current, [key]: !current[key] }));
  const sections = groups ? buildSections(groups) : [];
  const line = groups ? headerLine(headerCounts(groups)) : null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ paddingBottom: 24 }}>
      <View style={{ paddingTop: 12, paddingBottom: 10, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>Progress</Text>
        {line ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{line.before}<Text style={{ color: colors.statusDanger }}>{line.stuck}</Text>{line.after}</Text> : null}
      </View>
      {isLoading ? <Text style={{ margin: 20, color: colors.foregroundMuted, fontSize: 12 }}>Loading every board…</Text> : null}
      {error ? <Text style={{ margin: 20, color: colors.statusDanger, fontSize: 12 }}>Could not read the boards. Retrying.</Text> : null}
      {groups && !groups.length ? <Text style={{ margin: 20, color: colors.foregroundMuted, fontSize: 12 }}>No boards or live agents yet.</Text> : null}
      {groups ? <PageFeed colors={colors} groups={groups} now={now} navigation={navigation} /> : null}
      {sections.map((section) => {
        const folded = flipped[section.id] ? !section.foldedByDefault : section.foldedByDefault;
        return (
          <View key={section.id} style={{ marginHorizontal: 16, marginTop: 20, borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: !folded }} onPress={() => flip(section.id)}
              style={(state) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: isHovered(state) ? colors.surface2 : colors.surface1 })}>
              <Chevron colors={colors} open={!folded} />
              <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{section.title}</Text>
              <Text style={{ minWidth: 16, textAlign: "center", color: colors.foreground, backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 4, fontSize: 10, lineHeight: 14, fontWeight: "600", overflow: "hidden" }}>{section.groups.length}</Text>
              <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{section.sub}</Text>
            </Pressable>
            {folded ? null : (
              <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 20 }}>
                <SectionRepos colors={colors} groups={section.groups} isFolded={(group) => Boolean(flipped[`repo:${group.projectId}`])} flip={flip} now={now} navigation={navigation} hostId={host.id} />
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

// The sidebar's flag: the Lucide Flag icon and "Progress" (owner ruling).
export function ProgressSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Flag" label="Progress" active={currentScreen?.screenId === PROGRESS_SCREEN_ID} onPress={() => openScreen({ screenId: PROGRESS_SCREEN_ID })} />;
}
