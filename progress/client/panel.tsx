import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { DeliverablesList } from "./deliverables";
import { LauncherBanner, SkillBanner } from "./launcher";
import { HistoryRow } from "./history";
import { AnsweredQuestionsList, QuestionsSection } from "./questions";
import { Spinner, StalledPulse } from "./spinner";
import { IconSwap, Presence, StaggerRoot, nativeDriver } from "./motion";
import { SectionTitle } from "./section-title";
import { raised } from "./surfaces";
import { When } from "./when";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { finishedToFold, isFinished, shortTitle, ticketName, sortObjectives, rowTone, ticketDepth, type Activity, type Dashboard, type FileIssue, type ProgressSegment, type StuckItem, type Ticket } from "../shared/dashboard";
import type { BoardStatus } from "../shared/events";
import { formatMinutes, formatWorkDone, minutesSince } from "../shared/format";
import { markPanelOpened, getBeads, type BeadsResult } from "../shared/rpc";
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

function WorkspaceProgress({ theme, workspaceId, host, layout, navigation }: PluginWorkspacePanelProps) {
  const colors = theme.colors;
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  // Paseo marks the workspace running while any of its agents is. Since 0.11 a Claude
  // agent waiting on background subagents counts as idle, so those subagents record
  // progress themselves (see the skill).
  const agentRunning = useWorkspace(workspaceId, (workspace) => workspace.status === "running") ?? false;
  // The header control folds the run: this workspace's run or the whole file ("All" is 0.4.0).
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const query = useDashboard(host.id, workspaceId, directory, scope);
  const result = query.data ?? null;
  useMarkPanelOpened(workspaceId, directory, Boolean(result?.configured && !result.panelOpened));
  const [narrow, setNarrow] = useState(false);
  const beads = useBeads(workspaceId, result?.root);

  return (
    <NarrowProvider value={narrow}>
    <ScrollView onLayout={(event) => setNarrow(event.nativeEvent.layout.width <= NARROW_MAX)}
      style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ paddingBottom: 16 }}>
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
        workspaceId={workspaceId} workspaceDirectory={result.root} file={result.file} navigation={navigation} scope={scope} onScopeChange={setScope} gitOnly={Boolean(directory && result.root && directory !== result.root)} beads={beads} /> : null}
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

// How often the Beads tab re-reads the record (owner ruling: added, renamed,
// closed and reopened beads must show up without reopening the panel).
export const BEADS_REFRESH_MS = 10_000;

// A readonly beads read on mount, then every BEADS_REFRESH_MS. An unchanged
// read keeps the same object, so the list does not re-render; a failed
// refresh keeps the last good list, and only a first-read failure shows.
function useBeads(workspaceId: string, root: string | undefined): BeadsResult | null {
  const fetchBeads = useRpc(getBeads);
  const [beads, setBeads] = useState<BeadsResult | null>(null);
  useEffect(() => {
    if (!root) return;
    let stale = false;
    let last = "";
    const read = () => fetchBeads({ workspaceId, workspaceDirectory: root })
      .then((result) => {
        const text = JSON.stringify(result);
        if (stale || text === last) return;
        last = text;
        setBeads(result as BeadsResult);
      })
      .catch(() => { if (!stale && !last) setBeads({ state: "error", message: "Could not read beads" }); });
    void read();
    const timer = setInterval(read, BEADS_REFRESH_MS);
    return () => { stale = true; clearInterval(timer); };
  }, [fetchBeads, workspaceId, root]);
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

// Re-renders on an interval so "x min ago" keeps counting between polls.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const WIDE_MIN = 760;

function DashboardView({ colors, dashboard, agentRunning, compact, workspaceId, workspaceDirectory, file, navigation, scope, onScopeChange, gitOnly, beads }: {
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
}) {
  const now = useNow(15_000);
  // Quiet isn't stale while an agent in the workspace is still running.
  const stale = dashboard.stale && !agentRunning;
  const hasHistory = dashboard.activity.length + dashboard.questions.answered.length + dashboard.deliverables.length > 0;
  // The top section row (owner retab): Tickets, Beads, GH Issues, where the
  // tickets section sits. The history card is history only — beads moved up.
  const showHistory = hasHistory;
  const live = !stale;
  // Two columns when opened as a wide tab; one in the narrow Explorer pane.
  const [wide, setWide] = useState(false);
  const narrow = useNarrow();
  const attachmentContext = { workspaceId, workspaceDirectory, navigation };
  const [openTicket, setOpenTicket] = useState<string | null>(null);
  // The section the top tab row shows; Tickets first, always.
  const [section, setSection] = useState<"tickets" | "beads" | "gh">("tickets");
  const ticketsBody = (
    <View>
      <TicketList colors={colors} dashboard={dashboard} live={live} now={now} workspaceId={workspaceId} onOpen={setOpenTicket} />
      <TicketDialogs colors={colors} dashboard={dashboard} openId={openTicket} setOpenId={setOpenTicket} now={now} live={live} context={attachmentContext} />
    </View>
  );
  const sections = sectionTabs(colors, dashboard, beads, ticketsBody, workspaceId, workspaceDirectory);
  return (
    <StaggerRoot>
      <Presence show order={0}>
      <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10, gap: 4, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {/* Owner ruling (12 Oct): the title only — no subtitle or headline
            line; the scope toggle lives at the end of the tab strip. */}
        <Text accessibilityRole="header" numberOfLines={1} style={{ color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" }}>
          {dashboard.run?.title ?? "Progress"}
        </Text>
        {/* One status slot: the icon morphs from spinner (or stalled pulse) to the check on finish. */}
        {dashboard.run?.finished || dashboard.ticker ? (
          <StatusLine icon={
            <IconSwap swapKey={dashboard.run?.finished ? "finished" : live ? "live" : "stale"} size={12}>
              {dashboard.run?.finished ? <Icon name="CircleCheck" size={12} color={colors.statusSuccess} />
                : live ? <Spinner color={colors.accent} /> : <StalledPulse color={colors.statusWarning} />}
            </IconSwap>
          }>
            {dashboard.run?.finished ? (
              <>
                <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
                  <Text style={{ color: colors.statusSuccess, fontWeight: "600" }}>Finished</Text> <When colors={colors} iso={dashboard.run.finished.at} now={now} />
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
              Last updated <When colors={colors} iso={dashboard.updatedAt} now={now} />
            </Text>
          </StatusLine>
        ) : null}
      </View>
      </Presence>
      <Presence show={Boolean(stale && dashboard.updatedAt)} order={1}>{stale && dashboard.updatedAt ? (
        <View accessibilityRole="alert" style={{ flexDirection: "row", gap: 8, margin: 12, marginBottom: 0, padding: 10, borderWidth: 1, borderColor: colors.statusWarning, borderRadius: 6 }}>
          {/* Optical: centers the 14px icon on the first 18px line. */}
          <View style={{ paddingTop: 2 }}><Icon name="TriangleAlert" size={14} color={colors.statusWarning} /></View>
          <Text style={{ flex: 1, color: colors.statusWarning, fontSize: 12, lineHeight: 18 }}>
            Possibly stale. No update for {formatMinutes(minutesSince(dashboard.updatedAt, now))}. The work may have stopped, so working items show a warning until the next update.
          </Text>
        </View>
      ) : null}</Presence>
      <Presence show={Boolean(dashboard.issues.length)} order={1}>{dashboard.issues.length ? <IssuesNotice colors={colors} issues={dashboard.issues} file={file} /> : null}</Presence>
      <Presence show={Boolean(dashboard.progress.totalMin > 0)} order={2}>{dashboard.progress.totalMin > 0 ? <ProgressBar colors={colors} progress={dashboard.progress} live={live}
        updated={dashboard.updatedAt && !dashboard.run?.finished ? <When colors={colors} iso={dashboard.updatedAt} now={now} /> : null} /> : null}</Presence>
      <View onLayout={(event) => setWide(event.nativeEvent.layout.width >= WIDE_MIN)}
        style={{ flexDirection: wide ? "row" : "column", alignItems: "flex-start" }}>
        <View style={{ flex: wide ? 3 : undefined, alignSelf: "stretch", minWidth: 0 }}>
          <Presence show={dashboard.questions.open.length > 0} order={3}>{dashboard.questions.open.length ? (
            <QuestionsSection colors={colors} questions={dashboard.questions.open} answered={dashboard.questions.answered} now={now} context={attachmentContext} />
          ) : null}</Presence>
          <Presence show={Boolean(dashboard.stuck.length)} order={3}>{dashboard.stuck.length ? <StuckSection colors={colors} items={dashboard.stuck} now={now} /> : null}</Presence>
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
                  content: <ActivityList colors={colors} activity={dashboard.activity} now={now} /> },
                { id: "answered", label: "Answered", icon: "CircleCheck", count: dashboard.questions.answered.length, empty: "No answered questions yet.",
                  content: <AnsweredQuestionsList colors={colors} questions={dashboard.questions.answered} now={now} context={attachmentContext} /> },
                { id: "deliverables", label: "Deliverables", icon: "Package", count: dashboard.deliverables.length, empty: "No deliverables yet.",
                  content: <DeliverablesList colors={colors} deliverables={dashboard.deliverables} now={now} workspaceId={workspaceId}
                    workspaceDirectory={workspaceDirectory} navigation={navigation} /> },
              ]} />
            ) : null}
          </Presence>
        </View>
      </View>
    </StaggerRoot>
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
      style={{ margin: 12, marginBottom: 0, ...raised(colors), borderRadius: 6, overflow: "hidden" }}>
      <TabStrip colors={colors} narrow={narrow} tabs={tabs.map((entry) => ({ ...entry, icon: showIcons ? entry.icon : null }))} selected={current.id} onSelect={choose}
        style={{ paddingHorizontal: narrow ? 8 : 10 }} />
      {current.count === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 10, paddingVertical: 8 }}>{current.empty}</Text>
      ) : current.content}
    </View>
  );
}

// Newest first, 10 at a time (see usePaged).
function ActivityList({ colors, activity, now }: { colors: Colors; activity: Activity[]; now: number }) {
  const paged = usePaged(activity);
  return (
    <View>
      {paged.shown.map((entry, index) => (
        <View key={entry.id} style={{ paddingHorizontal: 10, paddingVertical: 8, gap: 1, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border }}>
          {/* Muted: a log to glance at, not something to act on. Two lines at most (o6.1). */}
          <Text selectable numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>{entry.text}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16, opacity: 0.8 }}>
            <When colors={colors} iso={entry.at} now={now} />
          </Text>
        </View>
      ))}
      <ShowMoreRow colors={colors} total={activity.length} paged={paged} />
    </View>
  );
}

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
    <View style={{ margin: 12, marginBottom: 0, ...raised(colors), borderRadius: 6, overflow: "hidden" }}>
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

function StuckSection({ colors, items, now }: { colors: Colors; items: StuckItem[]; now: number }) {
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
            <When colors={colors} iso={item.since} now={now} />
          </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// Whether the finished tickets at the top are shown, per workspace, kept for
// the app session like the history tab.
const finishedShown = new Map<string, boolean>();

// The objectives list through the shared list (O2600): the open rows in plan
// order, the finished ones folded behind a count header that opens, the
// whole list flat when everything is finished. Nested objectives (O1800)
// keep their numeric slug order and their depth indent.
function TicketList({ colors, dashboard, live, now, workspaceId, onOpen }: { colors: Colors; dashboard: Dashboard; live: boolean; now: number; workspaceId: string; onOpen(id: string): void }) {
  const [shown, setShown] = useState(() => finishedShown.get(workspaceId) ?? false);
  const toggle = () => {
    finishedShown.set(workspaceId, !shown);
    setShown(!shown);
  };
  const narrow = useNarrow();
  const sorted = sortObjectives(dashboard.tickets);
  const finished = finishedToFold(sorted);
  const open = sorted.filter((ticket) => !isFinished(ticket));
  const row = (ticket: Ticket) => (
    <TicketRow key={ticket.id} colors={colors} ticket={ticket} live={live} now={now} onOpen={() => onOpen(ticket.id)} depth={ticketDepth(ticket, dashboard.tickets)}
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
}

// One objective in the shared row style (O2600): the status mark, the tight
// id + title, the priority pill, the stage/started/waiting/note lines, the
// linkage chips — and the estimate, the one view that carries hours.
function TicketRow({ colors, ticket, live, now, onOpen, deliverables, depth = 0 }: { colors: Colors; ticket: Ticket; live: boolean; now: number; onOpen(): void; deliverables: number; depth?: number }) {
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
      priority={ticket.priority}
      detail={
        <>
          {working && ticket.stage && ticket.stageSince ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
              {ticket.stage} stage started <When colors={colors} iso={ticket.stageSince} now={now} />
            </Text>
          ) : null}
          {working && ticket.startedAt ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
              {narrow ? "Started " : "Working since "}<When colors={colors} iso={ticket.startedAt} now={now} />
            </Text>
          ) : null}
          {ticket.waitingFor ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Waits for {shortTitle(ticket.waitingFor.title)}</Text>
          ) : null}
          {/* At most NOTE_MAX characters on the row; the card shows the whole note. */}
          {ticket.note ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{clip(ticket.note, NOTE_MAX)}</Text> : null}
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
export function beadsTab(colors: Colors, beads: BeadsResult | null | undefined, workspaceId?: string, workspaceDirectory?: string): HistoryTabEntry {
  return {
    id: "beads",
    label: "Beads",
    icon: "CircleDot",
    count: beads?.state === "ok" ? beads.issues.filter((issue) => issue.status !== "closed").length : undefined,
    empty: "No beads in this repo",
    content: beads ? (
      <View>
        {workspaceId && workspaceDirectory
          ? <BeadsSheet colors={colors} result={beads} workspaceId={workspaceId} workspaceDirectory={workspaceDirectory} />
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
    beadsTab(colors, beads, workspaceId, workspaceDirectory),
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
