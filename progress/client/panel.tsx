import { type PluginWorkspacePanelProps, usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { loadWorkspaceOwner } from "./agents-list";
import { DeliverablesList } from "./deliverables";
import { LauncherBanner, SkillBanner } from "./launcher";
import { HistoryRow } from "./history";
import { AnsweredQuestionsList, QuestionsSection } from "./questions";
import { Spinner, StalledPulse } from "./spinner";
import { IconSwap, Presence, StaggerRoot, nativeDriver } from "./motion";
import { SectionTitle } from "./section-title";
import { raised, sidebarTone } from "./surfaces";
import { When } from "./when";
import { NowProvider, useNowClock } from "./now";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { boardStatuses, closingNote, connDisplay, connLabel, displayPriority, finishedNewest, holdHover, holdLabel, indicatorLabel, isAutoPullable, labeledLine, liveObjectives, objectiveFeed, owedStuck, splitFinished, tickerIcon, type Conn, type Hold, isFinished, type Indicator, shortTitle, ticketName, sortObjectives, promotedBeads, rowTone, ticketDepth, type Activity, type Dashboard, type FileIssue, type ProgressSegment, type StuckItem, type Ticket } from "../shared/dashboard";
import type { BoardStatus } from "../shared/events";
import { formatMinutes, formatWorkDone, quietSince } from "../shared/format";
import { markPanelOpened, getBeads, reportPerf, type BeadsResult } from "../shared/rpc";
import { countRender, mark, watchPanel } from "./perf";
import { useDashboard } from "./dashboard-query";
import { statusLabel } from "./status-badge";
import { TicketDialogs } from "./ticket-dialog";
import { BeadsView } from "./beads";
import { BeadsSheet } from "./beads-sheet";
import { RefChips } from "./row";
import { DoneSinkRow, NOTE_MAX, PendingMark, UnifiedList, UnifiedRow, clip } from "./unified-list";
import { TabStrip } from "./tabs";
import { ShowMoreRow, usePaged } from "./show-more";
import { notePanelOpened } from "./panel-opened";
import { NARROW_MAX, NarrowProvider, useNarrow } from "./narrow";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];


const mono = () => (Platform.OS === "ios" ? "Menlo" : "monospace");

export function ProgressPanel(props: PluginWorkspacePanelProps) {
  return <WorkspaceProgress key={`${props.host.id}:${props.workspaceId}`} {...props} />;
}

// Marks how long a component took to render and commit, for the freeze log (o24).
function useCommitMark(name: string) {
  const startedAt = performance.now();
  useLayoutEffect(() => { mark(`${name} commit ${Math.round(performance.now() - startedAt)}ms`); });
}

// Counts why a component rendered: which of the given values changed since its
// last render, or "nothing of mine" when only a parent or a subscription did.
function useWhyRendered(name: string, values: Record<string, unknown>) {
  const previous = useRef(values);
  const changed = Object.keys(values).filter((key) => !Object.is(previous.current[key], values[key]));
  previous.current = values;
  countRender(name, changed.join(",") || "nothing of mine");
}

// True while this panel's document is showing. Views the host keeps mounted
// after navigation report hidden, so their cadences can pause instead of
// stacking (o24 follow-up: hidden panels were eating CPU on a remote client).
type PanelDocument = {
  visibilityState?: string;
  addEventListener?: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener?: (type: "visibilitychange", listener: () => void) => void;
};
const panelDocument = () => (globalThis as { document?: PanelDocument }).document;

export function useVisible(): boolean {
  const [visible, setVisible] = useState(() => panelDocument()?.visibilityState !== "hidden");
  useEffect(() => {
    const doc = panelDocument();
    if (!doc?.addEventListener) return;
    const onchange = () => setVisible(doc.visibilityState !== "hidden");
    doc.addEventListener("visibilitychange", onchange);
    return () => doc.removeEventListener?.("visibilitychange", onchange);
  }, []);
  return visible;
}

// A hidden panel schedules nothing.
export function cadence(baseMs: number, visible: boolean): number {
  return visible ? baseMs : 0;
}

function WorkspaceProgress({ theme, workspaceId, host, layout, navigation }: PluginWorkspacePanelProps) {
  useCommitMark("Panel");
  const sendPerf = useRpc(reportPerf);
  useEffect(() => watchPanel((lines) => { void sendPerf({ lines }).catch(() => {}); }), [sendPerf]);
  const colors = theme.colors;
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  // Paseo marks the workspace running while any of its agents is. Since 0.11 a Claude
  // agent waiting on background subagents counts as idle, so those subagents record
  // progress themselves (see the skill).
  const agentRunning = useWorkspace(workspaceId, (workspace) => workspace.status === "running") ?? false;
  // The header control folds the run: this workspace's run or the whole file ("All" is 0.4.0).
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  // Pausing cadences needs the panel's own visibility, not the window's focus.
  const visible = useVisible();
  const query = useDashboard(host.id, workspaceId, directory, scope, visible);
  const result = query.data ?? null;
  useMarkPanelOpened(workspaceId, directory, Boolean(result?.configured && !result.panelOpened));
  const [narrow, setNarrow] = useState(false);
  // Told by the dashboard view which section shows; the Beads read runs fast only for its own.
  const [beadsShowing, setBeadsShowing] = useState(false);
  const beads = useBeads(workspaceId, result?.root, beadsShowing, visible);
  useWhyRendered("Panel", { theme, workspaceId, host, layout, navigation, scope, visible, narrow, beadsShowing, result, agentRunning, directory, beads });

  return (
    <NarrowProvider value={narrow}>
    <ScrollView onLayout={(event) => setNarrow(event.nativeEvent.layout.width <= NARROW_MAX)}
      style={{ flex: 1, backgroundColor: sidebarTone(colors) }} contentContainerStyle={{ paddingBottom: 16 }}>
      {query.isPending ? <ActivityIndicator color={colors.foregroundMuted} accessibilityLabel="Loading progress" style={{ padding: 12 }} /> : null}
      {query.error ? (
        <Text accessibilityRole="alert" selectable style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18, padding: 12 }}>
          Could not read progress: {query.error.message}
        </Text>
      ) : null}
      <LauncherBanner colors={colors} host={host} />
      <SkillBanner colors={colors} host={host} />
      {/* Fades in like the dashboard's sections instead of popping in after the spinner. */}
      <Presence show={Boolean(result && !result.configured)}>{result && !result.configured ? <EmptyState colors={colors} file={result.file} /> : null}</Presence>
      {/* Keyed by run: a new run starts with fresh tabs, pages and dialogs. */}
      {result?.configured ? <DashboardView key={result.dashboard.run?.startedAt ?? "none"} colors={colors} dashboard={result.dashboard} agentRunning={agentRunning} compact={layout.compact}
        workspaceId={workspaceId} workspaceDirectory={result.root} file={result.file} navigation={navigation} scope={scope} onScopeChange={setScope} gitOnly={Boolean(directory && result.root && directory !== result.root)} beads={beads} onBeadsShowing={setBeadsShowing} visible={visible} /> : null}
      {result?.inRepo && directory ? <HistoryRow colors={colors} workspaceId={workspaceId} directory={directory} savedTo={result.savedTo} /> : null}
    </ScrollView>
    </NarrowProvider>
  );
}

// Once a run exists, opening the panel retires the "Progress" pill for
// this worktree, now and after restarts.
function useMarkPanelOpened(workspaceId: string, directory: string | null, needed: boolean) {
  const mark = useRpc(markPanelOpened);
  const sent = useRef(false);
  useEffect(() => {
    if (!needed || !directory || sent.current) return;
    sent.current = true;
    // Tell the pill only once the file exists, so its next poll agrees.
    mark({ workspaceId, workspaceDirectory: directory })
      .then(() => notePanelOpened(workspaceId))
      .catch(() => { sent.current = false; });
  }, [needed, directory, workspaceId, mark]);
}

// How often the Beads tab re-reads the record while it is showing (owner
// ruling: added, renamed, closed and reopened beads must show up without
// reopening the panel). Hidden, it only keeps the badge numbers current.
export const BEADS_REFRESH_MS = 10_000;
export const BEADS_BACKGROUND_MS = 60_000;

// What the Beads read does now: how often to repeat, and whether the list is
// old enough to read at once (owner ruling: refresh on focus if out of date).
export function beadsPoll(active: boolean, ageMs: number): { readNow: boolean; everyMs: number } {
  return { readNow: ageMs >= BEADS_REFRESH_MS, everyMs: active ? BEADS_REFRESH_MS : BEADS_BACKGROUND_MS };
}

// A readonly beads read on mount, then on beadsPoll's rhythm. An unchanged
// read keeps the same object, so the list does not re-render; a failed
// refresh keeps the last good list, and only a first-read failure shows.
function useBeads(workspaceId: string, root: string | undefined, active: boolean, visible: boolean): BeadsResult | null {
  const fetchBeads = useRpc(getBeads);
  const [beads, setBeads] = useState<BeadsResult | null>(null);
  // Outlives the effect, so a tab switch knows how old the list is.
  const memo = useRef({ key: "", readAt: 0, last: "" });
  useEffect(() => {
    if (!root) return;
    const key = `${workspaceId}\0${root}`;
    if (memo.current.key !== key) memo.current = { key, readAt: 0, last: "" };
    const mine = memo.current;
    let stale = false;
    const read = () => {
      mine.readAt = Date.now();
      return fetchBeads({ workspaceId, workspaceDirectory: root })
        .then((result) => {
          const text = JSON.stringify(result);
          mark(`beads read ${Date.now() - mine.readAt}ms ${text === mine.last ? "unchanged" : "changed"} ${text.length}B`);
          if (stale || text === mine.last) return;
          mine.last = text;
          setBeads(result as BeadsResult);
        })
        .catch(() => { if (!stale && !mine.last) setBeads({ state: "error", message: "Could not read beads" }); });
    };
    const poll = beadsPoll(active, mine.readAt ? Date.now() - mine.readAt : Number.POSITIVE_INFINITY);
    if (poll.readNow && visible) void read();
    const every = cadence(poll.everyMs, visible);
    const timer = every ? setInterval(read, every) : undefined;
    return () => { stale = true; if (timer) clearInterval(timer); };
  }, [fetchBeads, workspaceId, root, active, visible]);
  return beads;
}

function EmptyState({ colors, file }: { colors: Colors; file: string }) {
  return (
    <View style={{ padding: 12, paddingTop: 20, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="ListChecks" size={18} color={colors.foregroundMuted} />
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "500" }}>
          No progress recorded yet
        </Text>
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
        An agent working in this worktree records progress with the <Text style={{ color: colors.foreground }}>paseo-progress</Text> command. It shows up here as soon as the first run starts.
      </Text>
      <View style={{ backgroundColor: colors.surface1, borderRadius: 6, padding: 10 }}>
        <Text selectable style={{ color: colors.foreground, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>
          {`paseo-progress start "Build the export feature"\npaseo-progress ticket add "Ticket 01: Export button" --estimate 60`}
        </Text>
      </View>
      {/* So people know nothing lands in the repo. */}
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
        Progress is saved outside the repo, in <Text selectable style={{ color: colors.foreground }}>{file}</Text>, so git never sees it.
      </Text>
    </View>
  );
}

// A 12px icon hung beside 12/18 text. Top-aligned with an optical nudge so the
// icon stays on the first line when the text wraps.
function StatusLine({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <View style={{ paddingTop: 3 }}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}

// The panel clock's cadence (o47.4): the tick lives in DashboardView and
// reaches the tree through the Now context, so only the leaves that show a
// time repaint.
export const NOW_TICK_MS = 15_000;

// Re-renders on an interval so "x min ago" keeps counting between polls.
function useNow(intervalMs: number, visible: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => { mark(`useNow tick ${intervalMs}ms`); setNow(Date.now()); }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, visible]);
  return now;
}

const WIDE_MIN = 760;

function DashboardView({ colors, dashboard, agentRunning, compact, workspaceId, workspaceDirectory, file, navigation, scope, onScopeChange, gitOnly, beads, onBeadsShowing, visible }: {
  colors: Colors;
  dashboard: Dashboard;
  agentRunning: boolean;
  compact: boolean;
  workspaceId: string;
  workspaceDirectory: string;
  file: string;
  navigation: PluginWorkspacePanelProps["navigation"];
  scope: Scope;
  onScopeChange(scope: Scope): void;
  // A workspace inside the repo but not at its root is a worktree (or a
  // subdirectory): the workspace fold no-ops there, so the toggle shows GIT only.
  gitOnly: boolean;
  beads: BeadsResult | null;
  // Whether the Beads section is the one showing, so its read can slow down when it is not.
  onBeadsShowing(showing: boolean): void;
  // True while this panel's document shows; hidden panels pause every cadence.
  visible: boolean;
}) {
  useCommitMark("DashboardView");
  const now = useNow(NOW_TICK_MS, visible);
  useWhyRendered("DashboardView", { colors, dashboard, agentRunning, compact, workspaceId, workspaceDirectory, file, navigation, scope, onScopeChange, gitOnly, beads, onBeadsShowing, visible, now });
  // Quiet isn't stale while an agent in the workspace is still running.
  const statuses = boardStatuses(dashboard, agentRunning);
  // Stale only while in-progress work has gone quiet: an idle board is never stale.
  const stale = statuses.some((status) => status.kind === "stale");
  const ticker = tickerIcon(statuses, Boolean(dashboard.run?.finished));
  const hasHistory = dashboard.activity.length + dashboard.questions.answered.length + dashboard.deliverables.length > 0;
  // The top section row (owner retab): Tickets, Beads, GH Issues, where the
  // tickets section sits. The history card is history only — beads moved up.
  const showHistory = hasHistory;
  const live = !stale;
  const orphanStuck = owedStuck(dashboard.stuck, dashboard.tickets).filter((item) => !item.ticketId);
  // Two columns when opened as a wide tab; one in the narrow Explorer pane.
  const [wide, setWide] = useState(false);
  const narrow = useNarrow();
  // Stable identity, so the memoised sections it feeds skip the tick (o47.4).
  const attachmentContext = useMemo(() => ({ workspaceId, workspaceDirectory, navigation }), [workspaceId, workspaceDirectory, navigation]);
  // o41: tapping the board name opens the agent that owns the board, through the host's own
  // navigation (the same call the ticket dialog uses), so nothing reloads. Read on the tap, not on a timer.
  const paseo = usePaseo();
  const toast = useToast();
  const openOwner = navigation ? async () => {
    try {
      const owner = await loadWorkspaceOwner(paseo, workspaceId);
      if (owner) navigation.openAgent({ agentId: owner.id });
      else toast.show("No agent owns this board yet.", { variant: "warning" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the owner.");
    }
  } : undefined;
  const [openTicket, setOpenTicket] = useState<string | null>(null);
  // The section the top tab row shows; Tickets first, always.
  const [section, setSection] = useState<"tickets" | "beads" | "gh">("tickets");
  // Whether the top-of-board feed is open, and whether its whole history is (o52).
  const [feedOpen, setFeedOpen] = useState(false);
  const [feedFull, setFeedFull] = useState(false);
  // Also fires on mount, so a new run (fresh tabs) tells the panel Beads is hidden again.
  useEffect(() => onBeadsShowing(section === "beads"), [section, onBeadsShowing]);
  const ticketsBody = (
    <View>
      <ObjectiveFeed colors={colors} tickets={dashboard.tickets} open={feedOpen} onOpen={() => setFeedOpen(!feedOpen)} expanded={feedFull} onExpand={() => setFeedFull(!feedFull)} />
      <TicketList colors={colors} dashboard={dashboard} live={live} workspaceId={workspaceId} onOpen={setOpenTicket} />
      <TicketDialogs colors={colors} dashboard={dashboard} openId={openTicket} setOpenId={setOpenTicket} now={now} live={live} context={attachmentContext} />
    </View>
  );
  const sections = sectionTabs(colors, dashboard, beads, ticketsBody, workspaceId, workspaceDirectory);
  // The tick hands its clock to the tree once, here (o47.4): the When and
  // quiet leaves below read it through context, and the memoised lists
  // between them skip the tick entirely.
  return (
    <NowProvider now={now}>
    <StaggerRoot>
      <Presence show order={0}>
      <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {/* Owner ruling (12 Oct): the title only — no subtitle or headline
            line; the scope toggle lives at the end of the tab strip. */}
        {/* The name shrinks and ellipsizes; the indicator keeps its width. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
            {dashboard.conn ? <ConnSign colors={colors} conn={dashboard.conn} now={now} /> : null}
            {dashboard.hold ? <HoldSign colors={colors} hold={dashboard.hold} /> : null}
            <Pressable accessibilityRole={openOwner ? "link" : "header"} accessibilityLabel={`${dashboard.run?.title ?? "Progress"}. Open the agent that owns this board`} {...(openOwner ? { title: "Open the agent that owns this board" } as object : {})}
              disabled={!openOwner} onPress={openOwner} style={({ pressed }) => ({ flex: 1, minWidth: 0, opacity: pressed ? 0.6 : 1 })}>
              <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>
                {dashboard.run?.title ?? "Progress"}
              </Text>
            </Pressable>
          </View>
          <StatusIndicator colors={colors} statuses={statuses} />
        </View>
        {/* One status slot: the icon morphs from spinner (or stalled pulse) to the check on finish. */}
        {dashboard.run?.finished || dashboard.ticker ? (
          <StatusLine icon={
            <IconSwap swapKey={ticker} size={12}>
              {ticker === "finished" ? <Icon name="CircleCheck" size={12} color={colors.statusSuccess} />
                : ticker === "live" ? <Spinner color={colors.accent} />
                : ticker === "stale" ? <StalledPulse color={colors.statusWarning} />
                : <Icon name="Circle" size={12} color={colors.foregroundMuted} />}
            </IconSwap>
          }>
            {dashboard.run?.finished ? (
              <>
                <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
                  <Text style={{ color: colors.statusSuccess, fontWeight: "600" }}>Finished</Text> <When colors={colors} iso={dashboard.run.finished.at} />
                </Text>
                <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>{dashboard.run.finished.outcome}</Text>
              </>
            ) : (
              <Text accessibilityLiveRegion="polite" style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>{dashboard.ticker!.text}</Text>
            )}
          </StatusLine>
        ) : null}
        {/* A finished run takes no more updates, so its finish time already says
            this. With estimates, it rides the progress row instead. */}
        {dashboard.updatedAt && !dashboard.run?.finished && !(dashboard.progress.totalMin > 0) ? (
          <StatusLine icon={<Icon name="Clock" size={12} color={colors.foregroundMuted} />}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
              Last updated <When colors={colors} iso={dashboard.updatedAt} />
            </Text>
          </StatusLine>
        ) : null}
      </View>
      </Presence>
      <Presence show={Boolean(dashboard.issues.length)} order={1}>{dashboard.issues.length ? <IssuesNotice colors={colors} issues={dashboard.issues} file={file} /> : null}</Presence>
      <Presence show={Boolean(dashboard.progress.totalMin > 0)} order={2}>{dashboard.progress.totalMin > 0 ? <ProgressBar colors={colors} progress={dashboard.progress} live={live}
        updated={dashboard.updatedAt && !dashboard.run?.finished ? <When colors={colors} iso={dashboard.updatedAt} /> : null} /> : null}</Presence>
      <View onLayout={(event) => setWide(event.nativeEvent.layout.width >= WIDE_MIN)}
        style={{ flexDirection: wide ? "row" : "column", alignItems: "flex-start" }}>
        <View style={{ flex: wide ? 3 : undefined, alignSelf: "stretch", minWidth: 0 }}>
          <Presence show={dashboard.questions.open.length > 0} order={3}>{dashboard.questions.open.length ? (
            <QuestionsSection colors={colors} questions={dashboard.questions.open} answered={dashboard.questions.answered} now={now} context={attachmentContext} />
          ) : null}</Presence>
          {/* The indicator is the alert and each stuck objective's row carries its reason; only a flag with no objective needs a home here. */}
          <Presence show={Boolean(orphanStuck.length)} order={3}>{orphanStuck.length ? <StuckSection colors={colors} items={orphanStuck} /> : null}</Presence>
          <Presence show order={4}>
          {/* Panel B (owner ruling): the tabs live in the panel's own header —
              Objectives, Beads, GH Issues — and the chosen list renders under
              them inside the one panel. No dashboard-level tab strip. */}
          <Card colors={colors} header={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <TabStrip colors={colors} narrow={narrow} fit tabs={sections} selected={section} onSelect={(next) => setSection(next as "tickets" | "beads" | "gh")} />
              </View>
              {/* The WS/GIT toggle closes the tab row (owner ruling, 12 Oct). */}
              <View style={{ paddingEnd: 10 }}><ScopeToggle colors={colors} scope={scope} onChange={onScopeChange} gitOnly={gitOnly} /></View>
            </View>
          }>
            {sections.find((entry) => entry.id === section)?.content ?? null}
          </Card>
          </Presence>
        </View>
        <View style={{ flex: wide ? 2 : undefined, alignSelf: "stretch", minWidth: 0 }}>
          <Presence show={showHistory} order={5}>
            {showHistory ? (
              <HistoryCard colors={colors} workspaceId={workspaceId} tabs={[
                { id: "activity", label: "Activity", icon: "Activity", count: dashboard.activity.length, empty: "No activity yet.",
                  content: <ActivityList colors={colors} activity={dashboard.activity} /> },
                { id: "answered", label: "Answered", icon: "CircleCheck", count: dashboard.questions.answered.length, empty: "No answered questions yet.",
                  content: <AnsweredQuestionsList colors={colors} questions={dashboard.questions.answered} now={now} context={attachmentContext} /> },
                { id: "deliverables", label: "Deliverables", icon: "Package", count: dashboard.deliverables.length, empty: "No deliverables yet.",
                  content: <DeliverablesList colors={colors} deliverables={dashboard.deliverables} workspaceId={workspaceId}
                    workspaceDirectory={workspaceDirectory} navigation={navigation} /> },
              ]} />
            ) : null}
          </Presence>
        </View>
      </View>
    </StaggerRoot>
    </NowProvider>
  );
}

type HistoryTab = "activity" | "answered" | "deliverables" | "beads" | "tickets" | "gh";
type Scope = "workspace" | "all";
type HistoryTabEntry = { id: HistoryTab; label: string; icon: string; count?: number; empty: string; content: React.ReactNode };
// Below this width the tab icons drop, so all three labels fit in the Explorer pane.
const TAB_ICONS_MIN = 370;

// The tab chosen per workspace, kept for the app session so reopening the
// panel shows the same one.
const historyTabs = new Map<string, HistoryTab>();

// Activity, answered questions and deliverables share one card: they're rarely wanted at once.
function HistoryCard({ colors, workspaceId, tabs }: { colors: Colors; workspaceId: string; tabs: HistoryTabEntry[] }) {
  const [tab, setTab] = useState<HistoryTab>(() => historyTabs.get(workspaceId) ?? "activity");
  const [showIcons, setShowIcons] = useState(true);
  const narrow = useNarrow();
  const choose = (next: HistoryTab) => {
    historyTabs.set(workspaceId, next);
    setTab(next);
  };
  const current = tabs.find((entry) => entry.id === tab) ?? tabs[0];
  return (
    <View onLayout={(event) => setShowIcons(event.nativeEvent.layout.width >= TAB_ICONS_MIN)}
      style={{ margin: 12, marginBottom: 0, ...raised(colors), backgroundColor: colors.surface0, borderRadius: 6, overflow: "hidden" }}>
      <TabStrip colors={colors} narrow={narrow} tabs={tabs.map((entry) => ({ ...entry, icon: showIcons ? entry.icon : null }))} selected={current.id} onSelect={choose}
        style={{ paddingHorizontal: narrow ? 8 : 10 }} />
      {current.count === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 10, paddingVertical: 8 }}>{current.empty}</Text>
      ) : current.content}
    </View>
  );
}

// Newest first, 10 at a time (see usePaged). Memoised (o47.4): the clock
// moved to its When leaf, so a tick skips the list.
const ActivityList = React.memo(function ActivityList({ colors, activity }: { colors: Colors; activity: Activity[] }) {
  const paged = usePaged(activity);
  return (
    <View>
      {paged.shown.map((entry, index) => (
        <View key={entry.id} style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 1, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border }}>
          {/* Muted: a log to glance at, not something to act on. Two lines at most (o6.1). */}
          <Text selectable numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{entry.text}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16, opacity: 0.8 }}>
            <When colors={colors} iso={entry.at} />
          </Text>
        </View>
      ))}
      <ShowMoreRow colors={colors} total={activity.length} paged={paged} />
    </View>
  );
});

// Small and non-blocking: the rest of the dashboard still renders.
function IssuesNotice({ colors, issues, file }: { colors: Colors; issues: FileIssue[]; file: string }) {
  const shown = issues.slice(0, 5);
  return (
    <View style={{ flexDirection: "row", gap: 8, margin: 12, marginBottom: 0, padding: 8, borderRadius: 6, backgroundColor: colors.surface1 }}>
      <View style={{ paddingTop: 1.5 }}><Icon name="FileWarning" size={14} color={colors.statusWarning} /></View>
      <Text selectable style={{ flex: 1, color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
        Skipped {issues.length === 1 ? "1 line" : `${issues.length} lines`} in {file}:{" "}
        {shown.map((issue) => `line ${issue.line} (${issue.reason})`).join(", ")}
        {issues.length > shown.length ? `, and ${issues.length - shown.length} more` : ""}.
      </Text>
    </View>
  );
}

function Card({ colors, icon, title, header, children }: { colors: Colors; icon?: string; title?: string; header?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={{ margin: 12, marginBottom: 0, ...raised(colors), backgroundColor: colors.surface0, borderRadius: 6, overflow: "hidden" }}>
      {header ?? <SectionTitle colors={colors} icon={icon ?? "SquareList"} title={title ?? ""} />}
      {children}
    </View>
  );
}

function ProgressBar({ colors, progress, live, updated }: { colors: Colors; progress: Dashboard["progress"]; live: boolean; updated?: React.ReactNode }) {
  const narrow = useNarrow();
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          <Text style={{ color: colors.foreground, fontWeight: "600" }}>{progress.percent}%</Text> {narrow ? "done" : "of estimated work done"}
          {/* Last updated rides here (owner ruling, 12 Oct): one line less in the header. */}
          {updated ? <Text style={{ fontSize: 12 }}>{" · updated "}{updated}</Text> : null}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
          {formatWorkDone(progress.doneMin, progress.totalMin, progress.tookMin)}
        </Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: progress.percent }}
        style={{ flexDirection: "row", gap: 2, height: 8, borderRadius: 4, overflow: "hidden" }}>
        {progress.segments.map((segment) => (
          <Segment key={segment.id} colors={colors} segment={segment} live={live} />
        ))}
      </View>
    </View>
  );
}

function Segment({ colors, segment, live }: { colors: Colors; segment: ProgressSegment; live: boolean }) {
  const working = segment.status === "in_progress";
  const color = segment.status === "closed" ? colors.accent
    : working ? colors.accent
    : segment.status === "blocked" && !segment.waiting ? colors.statusDanger
    : colors.surface2;
  return (
    <View style={{ flex: segment.estimateMin, backgroundColor: color, opacity: working ? 0.45 : 1, overflow: "hidden" }}>
      {working && live ? <Shimmer /> : null}
    </View>
  );
}

// A soft pulse on the working segment. Stops when the dashboard is stale so a
// stalled run never looks live.
function Shimmer() {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: 900, useNativeDriver: nativeDriver() }),
      Animated.timing(value, { toValue: 0, duration: 900, useNativeDriver: nativeDriver() }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [value]);
  return <Animated.View style={{ flex: 1, backgroundColor: "#ffffff", opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0, 0.35] }) }} />;
}


const STUCK_ICON: Record<StuckItem["kind"], string> = { blocked: "Ban", overdue: "Hourglass", manual: "Flag" };

// The conn sign before the board name: the infinity sign and the FM budget,
// solid while live work is outstanding, dimmed when the engine only has the
// keep-alive pending or has gone quiet. Hover: budget, state, next nudge.
export function ConnSign({ colors, conn, now }: { colors: Colors; conn: Conn; now: number }) {
  const { solid, hover } = connDisplay(conn, now);
  return (
    <Text accessibilityLabel={hover} {...({ title: hover } as object)}
      style={{ flexShrink: 0, color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600", opacity: solid ? 1 : 0.35 }}>
      {connLabel(conn)}
    </Text>
  );
}

// o34: the hold sign beside the conn sign. Always full strength: a hold is the
// owner's word, so it never dims like an engine that went quiet.
export function HoldSign({ colors, hold }: { colors: Colors; hold: Hold }) {
  const hover = holdHover(hold);
  return (
    <Text accessibilityLabel={hover} {...({ title: hover } as object)}
      style={{ flexShrink: 0, color: colors.statusWarning, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>
      {holdLabel(hold)}
    </Text>
  );
}

// The board-name line's indicator: a filled dot per status (Idle's is hollow),
// green for idle and active, red for stale and stuck, all bold. Counts ride
// the word; the reasons ride the objective rows.
export function StatusIndicator({ colors, statuses }: { colors: Colors; statuses: Indicator[] }) {
  return (
    <View accessibilityRole="text" style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 0 }}>
      {statuses.map((status) => {
        const color = status.kind === "stale" || status.kind === "stuck" ? colors.statusDanger : colors.statusSuccess;
        const label = indicatorLabel(status);
        return (
          <View key={status.kind} accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, borderColor: color, backgroundColor: status.kind === "idle" ? "transparent" : color }} />
            <Text style={{ color, fontSize: 12, lineHeight: 18, fontWeight: "700" }}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

// Memoised (o47.4): the clock moved to its When leaf, so a tick skips it.
const StuckSection = React.memo(function StuckSection({ colors, items }: { colors: Colors; items: StuckItem[] }) {
  const narrow = useNarrow();
  return (
    <View style={{ margin: 12, marginBottom: 0, borderWidth: 1, borderColor: colors.statusDanger, borderRadius: 6, overflow: "hidden" }}>
      <SectionTitle colors={colors} icon="OctagonAlert" title="Stuck" color={colors.statusDanger} style={{ borderBottomWidth: 1, borderBottomColor: colors.border }} />
      {items.map((item, index) => (
        <View key={item.key} style={{ flexDirection: "row", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border }}>
          {/* Optical: centers the 14px icon on the 18px title line. */}
          <View style={{ paddingTop: 2 }}><Icon name={STUCK_ICON[item.kind]} size={14} color={colors.statusDanger} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{item.title}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
            {item.kind === "overdue" ? `No update for longer than its ${formatMinutes(item.estimateMin)} estimate. Last update ` : null}
            {item.kind === "blocked" ? `Blocked${item.note ? `: ${item.note}` : ""}${narrow ? ", " : ". Since "}` : null}
            {item.kind === "manual" ? `${item.ticketId ? `${item.reason}. ` : ""}Flagged ` : null}
            <When colors={colors} iso={item.since} />
          </Text>
          </View>
        </View>
      ))}
    </View>
  );
});

// Whether the finished tickets at the top are shown, per workspace, kept for
// the app session like the history tab.
const finishedShown = new Map<string, boolean>();

// The objectives list through the shared list (O2600): the open rows in plan
// order, the finished ones folded behind a count header that opens, the
// whole list flat when everything is finished. Nested objectives (O1800)
// keep their numeric slug order and their depth indent.
// Memoised (o47.4): its props are stable across a tick, so an unchanged
// dashboard object bails the tick before the list body runs; the When leaves
// inside its rows still repaint, through context. Exported for the memo pin.
export const TicketList = React.memo(function TicketList({ colors, dashboard, live, workspaceId, onOpen }: { colors: Colors; dashboard: Dashboard; live: boolean; workspaceId: string; onOpen(id: string): void }) {
  const [shown, setShown] = useState(() => finishedShown.get(workspaceId) ?? false);
  const toggle = () => {
    finishedShown.set(workspaceId, !shown);
    setShown(!shown);
  };
  const narrow = useNarrow();
  const sorted = sortObjectives(dashboard.tickets);
  const { listed: open, folded: finished } = splitFinished(sorted);
  // The indicator is the alert; each objective carries why it is stuck or stale.
  const reasons = new Map<string, string>();
  for (const item of owedStuck(dashboard.stuck, dashboard.tickets)) {
    if (!item.ticketId) continue;
    reasons.set(item.ticketId, item.kind === "blocked" ? "Blocked"
      : item.kind === "overdue" ? `No update for longer than its ${formatMinutes(item.estimateMin)} estimate`
      : item.reason);
  }
  const row = (ticket: Ticket) => (
    <TicketRow key={ticket.id} colors={colors} ticket={ticket} live={live} onOpen={() => onOpen(ticket.id)} depth={ticketDepth(ticket, dashboard.tickets)}
      reason={reasons.get(ticket.id)}
      quiet={!reasons.has(ticket.id) && ticket.status === "in_progress" ? <QuietNote colors={colors} live={live} updatedAt={dashboard.updatedAt} /> : undefined}
      autoPull={isAutoPullable(ticket)}
      deliverables={dashboard.deliverables.filter((deliverable) => deliverable.ticketId === ticket.id).length} />
  );
  const done = finished.filter((ticket) => ticket.closeReason !== "skipped").length;
  const skipped = finished.length - done;
  return (
    <UnifiedList
      colors={colors}
      narrow={narrow}
      openRows={open.map(row)}
      closedRows={finished.map(row)}
      foldLabel={finished.length ? [done ? `${done} done` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean).join(", ") : ""}
      foldDone={done}
      foldEstimateMin={finished.reduce((sum, ticket) => sum + (ticket.closeReason !== "skipped" ? ticket.estimateMin : 0), 0)}
      shown={shown}
      onToggleFold={toggle}
      empty={`No ${(dashboard.run?.itemLabel ?? "ticket").toLowerCase()}s yet.`}
    />
  );
});

// One objective in the shared row style (O2600): the status mark, the tight
// id + title, the priority pill, the stage/started/waiting/note lines, the
// linkage chips — and the estimate, the one view that carries hours.
function TicketRow({ colors, ticket, live, onOpen, deliverables, reason, quiet, autoPull, depth = 0 }: { colors: Colors; ticket: Ticket; live: boolean; onOpen(): void; deliverables: number; reason?: string; quiet?: React.ReactNode; autoPull: boolean; depth?: number }) {
  const muted = ticket.status === "closed" && ticket.closeReason === "skipped";
  const working = ticket.status === "in_progress";
  // Narrow: tighter gaps and no chevron (the whole row still presses), so the title keeps its width.
  const narrow = useNarrow();
  return (
    <UnifiedRow
      colors={colors}
      narrow={narrow}
      depth={depth}
      icon={
        <IconSwap swapKey={ticket.waitingFor || ticket.status === "open" ? "waiting" : working ? `working-${live}` : ticket.status} size={14}>
          <StatusIcon colors={colors} status={ticket.status} live={live} waiting={Boolean(ticket.waitingFor)} nested={depth > 0} />
        </IconSwap>
      }
      iconLabel={ticket.waitingFor ? "Waiting" : statusLabel(ticket.status, ticket.closeReason)}
      id={ticket.id}
      title={ticket.title}
      tone={rowTone(ticket.status)}
      dim={!muted && !working}
      strike={muted}
      priority={displayPriority(ticket)}
      autoPull={autoPull}
      detail={
        <>
          {reason ? <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 17, fontWeight: "600" }}>{reason}</Text> : null}
          {quiet}
          {working && ticket.stage && ticket.stageSince ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
              {ticket.stage} stage started <When colors={colors} iso={ticket.stageSince} />
            </Text>
          ) : null}
          {working && ticket.startedAt ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
              {narrow ? "Started " : "Working since "}<When colors={colors} iso={ticket.startedAt} />
            </Text>
          ) : null}
          {ticket.waitingFor ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Waits for {shortTitle(ticket.waitingFor.title)}</Text>
          ) : null}
          {/* At most NOTE_MAX characters on the row; the card shows the whole note. */}
          <LabeledNote colors={colors} ticket={ticket} />
        </>
      }
      chips={<RefChips colors={colors} ticket={ticket} />}
      estimateMin={ticket.estimateMin}
      deliverables={deliverables}
      onOpen={onOpen}
      accessibilityLabel={`${ticket.id} details`}
    />
  );
}

// Des, 19 Oct (o239): the feed at the top of the panel. Now comes from board
// truth, never a stale note; the recent objective and status changes follow
// with their times; the recent completions carry their RESULT line; the full
// history sits behind one More info toggle. A label rides a row and never
// decides whether the row appears.
export const FEED_ROWS = 6;
export const FINISHED_ROWS = 5;

export function ObjectiveFeed({ colors, tickets, open, onOpen, expanded, onExpand }: { colors: Colors; tickets: Ticket[]; open: boolean; onOpen(): void; expanded: boolean; onExpand(): void }) {
  const feed = objectiveFeed(tickets);
  const live = liveObjectives(tickets);
  const finished = finishedNewest(tickets);
  if (!feed.length && !live.length) return null;
  const shown = expanded ? feed : feed.slice(0, FEED_ROWS);
  // Called, not mounted, so the group headings are part of this element tree.
  const group = (key: string, title: string, children: React.ReactNode) => (
    <View key={key} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6, paddingBottom: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 10, lineHeight: 14, fontWeight: "600", paddingHorizontal: 10 }}>{title}</Text>
      <View style={{ paddingHorizontal: 10, paddingTop: 2, gap: 4 }}>{children}</View>
    </View>
  );
  return (
    <View style={{ margin: 12, marginBottom: 0, borderWidth: 1, borderColor: colors.border, borderRadius: 6, overflow: "hidden" }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onOpen}>
        <SectionTitle colors={colors} icon="Activity" title="Feed" style={{ borderBottomWidth: open ? 1 : 0, borderBottomColor: colors.border }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{feed.length}</Text>
        </SectionTitle>
      </Pressable>
      {open ? (
        <>
          {group("now", "Now", live.length
            ? live.slice(0, 3).map((ticket) => (
              <View key={ticket.id}>
                <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, lineHeight: 17, fontWeight: "500" }}>{ticket.title}</Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{ticket.stage ? `${ticket.stage} stage` : "Working"} <When colors={colors} iso={ticket.startedAt ?? ticket.statusSince} /></Text>
              </View>
            ))
            : <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{finished.length ? "Nothing running — finished, gone idle" : "Nothing running"}</Text>)}
          {group("changed", "Recently changed", shown.map((change) => (
            <View key={change.key}>
              <Text numberOfLines={1} style={{ color: change.what === "Completed" ? colors.statusSuccess : colors.foreground, fontSize: 12, lineHeight: 17 }}>{change.ticket.title}</Text>
              <Text style={{ color: change.what === "Completed" ? colors.statusSuccess : colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{change.what} <When colors={colors} iso={change.at} /></Text>
            </View>
          )))}
          {finished.length ? group("finished", "Finished", finished.slice(0, FINISHED_ROWS).map((ticket) => {
            const result = labeledLine(closingNote(ticket));
            return (
              <View key={ticket.id}>
                <Text numberOfLines={2} style={{ color: colors.statusSuccess, fontSize: 12, lineHeight: 17 }}>{ticket.title}</Text>
                <Text style={{ color: colors.statusSuccess, fontSize: 11, lineHeight: 16 }}>Completed <When colors={colors} iso={ticket.statusSince} /></Text>
                {result?.label === "RESULT" ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{result.text}</Text> : null}
              </View>
            );
          })) : null}
          {feed.length > FEED_ROWS ? (
            <Pressable accessibilityRole="button" onPress={onExpand}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16, paddingHorizontal: 10, paddingVertical: 8 }}>{expanded ? "Show less" : `More info (${feed.length})`}</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

// The note line on a card (Des, 19 Oct): the GOAL text while the objective is
// open, the RESULT text from the close note once it is closed, the label
// stripped because the card's own state says which one it is. A note with
// neither label renders exactly as it always did. Hook-free so the render pin
// can call it straight through the client harness.
export function LabeledNote({ colors, ticket }: { colors: Colors; ticket: Ticket }) {
  const labeled = labeledLine(ticket.status === "closed" ? closingNote(ticket) : ticket.note);
  const wanted = ticket.status === "closed" ? "RESULT" : "GOAL";
  if (labeled && labeled.label === wanted) {
    return <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 17 }}>{labeled.text}</Text>;
  }
  return ticket.note ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{clip(ticket.note, NOTE_MAX)}</Text> : null;
}

// The quiet line under a working objective ("No update for 23 min"): reads
// the clock here, in a leaf, so neither the list nor the row re-renders on
// the tick — only this line repaints (o47.4).
function QuietNote({ colors, live, updatedAt }: { colors: Colors; live: boolean; updatedAt: string | null }) {
  const now = useNowClock();
  if (live || !updatedAt) return null;
  return <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 17, fontWeight: "600" }}>{quietSince(updatedAt, now)}</Text>;
}

function StatusIcon({ colors, status, live, waiting, nested = false }: { colors: Colors; status: BoardStatus; live: boolean; waiting: boolean; nested?: boolean }) {
  if (waiting) return <PendingMark colors={colors} nested={nested} />;
  switch (status) {
    case "closed":
      return <Icon name="Check" size={14} color={colors.statusSuccess} />;
    case "in_progress":
      return live ? <Spinner color={colors.accent} size={14} /> : <StalledPulse color={colors.statusWarning} size={14} />;
    case "blocked":
      return <Icon name="Ban" size={14} color={colors.statusDanger} />;
    default:
      // Open, and every step still ahead gets the same dot (a ">" when nested); "Waits for" says which ones are held up.
      return <PendingMark colors={colors} nested={nested} />;
  }
}


// The panel header's scope control: fold this workspace's run or the whole
// file. "All" shows exactly what 0.4.0 showed.
export const DEFAULT_SCOPE: Scope = "workspace";

export function ScopeControl({ colors, scope, onChange }: { colors: Colors; scope: Scope; onChange(scope: Scope): void }) {
  const choices = [
    { id: "workspace" as const, label: "This workspace" },
    { id: "all" as const, label: "All" },
  ];
  return (
    <View style={{ flexDirection: "row", gap: 6 }} accessibilityRole="tablist">
      {choices.map((choice) => {
        const selected = choice.id === scope;
        return (
          <Pressable key={choice.id} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={choice.label} onPress={() => onChange(choice.id)}
            style={({ pressed }) => ({ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5, backgroundColor: selected || pressed ? colors.surface2 : colors.surface1 })}>
            <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 11, lineHeight: 16, fontWeight: "600" }}>{choice.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// The Beads section (O2600): the repo's recorded work through the same shared
// card frame the objectives list uses. The badge counts the OPEN beads — the
// work still ahead; closed ones ride in the read and fold behind the
// done-sink. With the workspace identity the section is read-write: rows tap
// open the detail sheet (beads-sheet.tsx). Without one it stays the pure
// read-only view.
export function beadsTab(colors: Colors, beads: BeadsResult | null | undefined, workspaceId?: string, workspaceDirectory?: string, promoted?: ReadonlyMap<string, string>): HistoryTabEntry {
  return {
    id: "beads",
    label: "Beads",
    icon: "CircleDot",
    count: beads?.state === "ok" ? beads.issues.filter((issue) => issue.status !== "closed").length : undefined,
    empty: "No beads in this repo",
    content: beads ? (
      <View>
        {workspaceId && workspaceDirectory
          ? <BeadsSheet colors={colors} result={beads} workspaceId={workspaceId} workspaceDirectory={workspaceDirectory} promoted={promoted} />
          : <BeadsView colors={colors} result={beads} />}
      </View>
    ) : null,
  };
}

// The three sections (owner retab, tabs in Panel B's header, O2600):
// Objectives, Beads, GH Issues. The panel's own header hosts the tabs; the
// body renders the chosen list inside the one panel. GH Issues is a calm
// placeholder until the GitHub integration lands.
export function sectionTabs(colors: Colors, dashboard: Dashboard, beads: BeadsResult | null | undefined, ticketsContent: React.ReactNode, workspaceId?: string, workspaceDirectory?: string): HistoryTabEntry[] {
  const itemLabel = dashboard.run?.itemLabel ?? "Objective";
  return [
    { id: "tickets", label: `${itemLabel}s`, icon: "ListChecks", count: dashboard.tickets.filter((ticket) => !isFinished(ticket)).length, empty: `No ${itemLabel.toLowerCase()}s yet.`, content: ticketsContent },
    beadsTab(colors, beads, workspaceId, workspaceDirectory, promotedBeads(dashboard.tickets)),
    { id: "gh", label: "GH", icon: "Github", empty: "Not yet.", content: (
      <View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 10, paddingVertical: 8 }}>
          GitHub issues: not yet.
        </Text>
      </View>
    ) },
  ];
}

// The header's scope toggle (owner ruling): ONE card-like button showing WS
// or GIT — fixed size either way, tap to flip. WS folds this workspace's run;
// GIT folds the whole file ("All", exactly 0.4.0). Inside a worktree the
// workspace fold no-ops, so GIT shows alone and stays still.
export function ScopeToggle({ colors, scope, onChange, gitOnly = false }: { colors: Colors; scope: Scope; onChange(scope: Scope): void; gitOnly?: boolean }) {
  const label = gitOnly || scope === "all" ? "GIT" : "WS";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: scope === "all" }}
      onPress={gitOnly ? undefined : () => onChange(scope === "workspace" ? "all" : "workspace")}
      style={({ pressed }) => ({ minWidth: 44, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? colors.surface2 : colors.surface1 })}>
      <Text style={{ color: colors.foreground, fontSize: 11, lineHeight: 16, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{label}</Text>
    </Pressable>
  );
}
