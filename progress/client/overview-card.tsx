import { type PluginScreenProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { formatAgo, formatWorkDone } from "../shared/format";
import { MODE_LABEL, autoUnderneath, modeOf, ownerAgent, type BoardMode } from "../shared/modes";
import {
  MODE_BUTTONS, MODE_TINT, archiveConfirm, barSegments, cardAgents, plainName, modeConfirm, optionHint, priorityChips, readyRows, resultLine, statusDots,
  type AgentRef, type ArchiveTarget, type BarSegment, type WorkspaceEntry,
} from "../shared/overview";
import { setBoardMode } from "../shared/rpc";
import { ConnSign } from "./panel";
import { Spinner, StalledPulse } from "./spinner";

// o38: one board as a card, and the repo's agents without a board. The rules
// (bar, chips, hints, results) are pure and tested in shared/overview.ts; this
// is the look and the one write, the state selector.

type Colors = PluginScreenProps["theme"]["colors"];
type Navigation = PluginScreenProps["navigation"];

// The design's blue for full auto; the theme has no blue of its own.
const AUTO_BLUE = "#5caaf6";
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" } as const;

const AGENT_DOT: Record<AgentRef["status"], (colors: Colors) => string> = {
  running: (colors) => colors.statusSuccess,
  initializing: (colors) => colors.statusSuccess,
  error: (colors) => colors.statusDanger,
  idle: (colors) => colors.foregroundMuted,
  closed: (colors) => colors.foregroundMuted,
};

const dotColor = (kind: "stuck" | "stale" | "active" | "idle", colors: Colors) =>
  kind === "stuck" ? colors.statusDanger : kind === "stale" ? colors.statusWarning : colors.statusSuccess;

function segmentColor(segment: BarSegment, colors: Colors): { backgroundColor: string; opacity: number } {
  if (segment.kind === "done") return { backgroundColor: colors.accent, opacity: 1 };
  if (segment.kind === "progress") return segment.tint === "warning" ? { backgroundColor: colors.statusWarning, opacity: 0.6 } : { backgroundColor: colors.accent, opacity: 0.45 };
  return segment.tint === "danger" ? { backgroundColor: colors.statusDanger, opacity: 0.6 } : { backgroundColor: colors.surface2, opacity: 1 };
}

// React Native Web passes `hovered` to a Pressable's style function; the native types leave it out.
export const isHovered = (state: object) => Boolean((state as { hovered?: boolean }).hovered);

const ring = (colors: Colors) => ({ borderWidth: 1, borderColor: colors.border, borderRadius: 6 }) as const;

// o38.1 and o38.2: an archive icon that asks first. The confirm says what goes
// (pure, in shared/overview.ts); the call is the Paseo SDK's own archive. A
// refusal (a running agent, say) shows as the toast and nothing is half done.
function ArchiveButton({ colors, target, run, label }: { colors: Colors; target: ArchiveTarget; run(): Promise<unknown>; label?: boolean }) {
  const [asking, setAsking] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = archiveConfirm(target);
  const mutation = useMutation({
    mutationFn: run,
    onSuccess: () => { setAsking(false); toast.show(`Archived "${target.name}".`, { variant: "success" }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not archive."),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["progress", "overview"] }),
  });
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={confirm.action} {...({ title: confirm.action } as object)} onPress={() => setAsking(true)}
        style={(state) => ({ flexDirection: "row", alignItems: "center", gap: 6, padding: 4, borderRadius: 4, backgroundColor: isHovered(state) ? colors.surface2 : "transparent" })}>
        <Icon name="Archive" size={13} color={colors.foregroundMuted} />
        {label ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16, fontWeight: "600" }}>{confirm.action}</Text> : null}
      </Pressable>
      <ConfirmModal colors={colors} open={asking} icon="Archive" title={confirm.title} body={confirm.body} action={confirm.action} busyAction="Archiving…" busy={mutation.isPending} danger
        onCancel={() => setAsking(false)} onConfirm={() => mutation.mutate()} />
    </>
  );
}

// One confirm for every close or idle command on the page (Des, 16 Oct): what
// will happen in words, then Cancel or the action. Nothing runs until it is pressed.
function ConfirmModal({ colors, open, icon, title, body, action, busyAction, busy, danger = false, onCancel, onConfirm }: {
  colors: Colors; open: boolean; icon: string; title: string; body: string; action: string; busyAction?: string; busy: boolean; danger?: boolean; onCancel(): void; onConfirm(): void;
}) {
  return (
    <Modal title={title} icon={<Icon name={icon} size={16} color={colors.foregroundMuted} />} open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <Modal.Content>
        <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{body}</Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onCancel}
            style={(state) => ({ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: isHovered(state) ? colors.surface2 : "transparent" })}>
            <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>Cancel</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onConfirm}
            style={(state) => ({ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: danger ? colors.statusDanger : colors.accent, opacity: busy ? 0.6 : isHovered(state) ? 0.85 : 1 })}>
            <Text style={{ color: colors.accentForeground, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{busy && busyAction ? busyAction : action}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

const isWorking = (agent: AgentRef) => agent.status === "running" || agent.status === "initializing";

function AgentRow({ colors, agent, owner, navigation, hostId, indent = 12, archive }: { colors: Colors; agent: AgentRef; owner: boolean; navigation: Navigation; hostId: string; indent?: number; archive?: () => Promise<unknown> }) {
  const working = isWorking(agent);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingRight: archive ? 6 : 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Open agent ${agent.title ?? agent.id}`} disabled={!navigation?.openAgent}
      onPress={() => navigation?.openAgent({ agentId: agent.id, serverId: hostId })}
      style={(state) => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3, paddingLeft: indent, paddingRight: 12, backgroundColor: isHovered(state) ? colors.surface2 : "transparent" })}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: AGENT_DOT[agent.status](colors) }} />
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 12, lineHeight: 18 }}>{plainName(agent.title ?? agent.id)}</Text>
      {owner ? <Text style={{ color: colors.foregroundMuted, backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 4, fontSize: 10, lineHeight: 14, fontWeight: "600", overflow: "hidden" }}>Owner</Text> : null}
      <Text style={{ color: working ? colors.statusSuccess : agent.status === "error" ? colors.statusDanger : colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{working ? "active" : agent.status}</Text>
    </Pressable>
    {archive ? <ArchiveButton colors={colors} target={{ kind: "agent", name: agent.title ?? agent.id, running: working }} run={archive} /> : null}
    </View>
  );
}

// The five states as one segmented control. Picking one calls the RPC; the
// shown state is never sent again, and nothing can be picked while a change is
// on its way. Hover (or the shown state) says what a pick would do.
function ModeSelector({ colors, entry, ownerName, ownerId }: { colors: Colors; entry: WorkspaceEntry; ownerName: string | null; ownerId: string | undefined }) {
  const { workspace, board } = entry;
  const send = useRpc(setBoardMode);
  const queryClient = useQueryClient();
  const shown = modeOf(board);
  const under = board?.hold ? autoUnderneath(board) : null;
  const [result, setResult] = useState<{ tone: "ok" | "warning"; text: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (mode: BoardMode) => send({ workspaceId: workspace.id, workspaceDirectory: workspace.directory, mode, ...(ownerId ? { agentId: ownerId } : {}) }),
    onSuccess: (outcome) => setResult(resultLine(outcome, ownerName)),
    onError: (error) => setResult({ tone: "warning", text: error instanceof Error ? error.message : "Could not change the board." }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["progress", "overview"] }),
  });
  // A new state on the board answers the question; drop the old result line.
  useEffect(() => setResult(null), [shown]);
  // Full auto and Clear the board are started by the seat, so they need one.
  const blocked = (mode: BoardMode) => (mode === "fullauto" || mode === "clear") && !ownerId;
  // Manual, Hold and Spec ask first; Clear the board and Full auto start work and go straight through.
  const [asking, setAsking] = useState<BoardMode | null>(null);
  const confirm = asking ? modeConfirm(asking, { name: workspace.name, owner: ownerName, fullAuto: Boolean(board?.conn), held: Boolean(board?.hold) }) : null;
  const run = (mode: BoardMode) => { setResult(null); mutation.mutate(mode); };
  const pick = (mode: BoardMode) => {
    if (mode === shown || mutation.isPending || blocked(mode)) return;
    if (modeConfirm(mode, { name: workspace.name, owner: ownerName, fullAuto: Boolean(board?.conn), held: Boolean(board?.hold) })) setAsking(mode);
    else run(mode);
  };
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 12, paddingVertical: 8, gap: 6, alignItems: "flex-start" }}>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", padding: 2, borderRadius: 6, backgroundColor: colors.surface0, borderWidth: 1, borderColor: colors.border, opacity: mutation.isPending ? 0.6 : 1 }}>
        {MODE_BUTTONS.map(({ mode, icon, label }) => {
          const selected = mode === shown;
          const auto = mode === "fullauto" || mode === "clear";
          return (
            <Pressable key={mode} accessibilityRole="radio" accessibilityState={{ selected, disabled: mutation.isPending || blocked(mode) }} accessibilityLabel={label}
              {...({ title: `${label}. ${optionHint(mode, ownerName, board?.conn ?? null)}` } as object)}
              disabled={mutation.isPending || blocked(mode)}
              onPress={() => pick(mode)}
              style={{ paddingHorizontal: 9, paddingVertical: 5, borderRadius: 4, backgroundColor: selected ? (auto ? AUTO_BLUE : colors.surface2) : "transparent", borderWidth: 1, borderColor: under === mode ? AUTO_BLUE : "transparent", opacity: blocked(mode) ? 0.4 : 1 }}>
              <Icon name={icon} size={15} color={selected ? (auto ? colors.surface0 : colors.foreground) : colors.foregroundMuted} />
            </Pressable>
          );
        })}
      </View>
      {mutation.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>Changing…</Text> : null}
      {result && !mutation.isPending ? <Text style={{ color: result.tone === "warning" ? colors.statusWarning : colors.statusSuccess, fontSize: 11, lineHeight: 16 }}>{result.text}</Text> : null}
      {confirm && asking ? (
        <ConfirmModal colors={colors} open icon={MODE_BUTTONS.find((button) => button.mode === asking)?.icon ?? "Pause"} title={confirm.title} body={confirm.body} action={confirm.action} busy={mutation.isPending}
          onCancel={() => setAsking(null)} onConfirm={() => { run(asking); setAsking(null); }} />
      ) : null}
    </View>
  );
}

export function BoardCard({ colors, entry, repoName, now, navigation, hostId, machine }: { colors: Colors; entry: WorkspaceEntry; repoName: string; now: number; navigation: Navigation; hostId: string; machine?: string }) {
  const { workspace, agents } = entry;
  const paseo = usePaseo();
  const board = entry.board!;
  const owner = ownerAgent(agents);
  const ownerName = owner ? plainName(owner.title ?? owner.id) : null;
  const dots = statusDots(board.statuses);
  const segments = barSegments(board);
  const { chips, lower } = priorityChips(board);
  const [showAll, setShowAll] = useState(false);
  const ready = readyRows(board, showAll);
  const total = board.open + board.inProgress + board.done;
  const stale = dots.some((dot) => dot.kind === "stale");
  const held = board.hold ? MODE_LABEL[modeOf(board)] : null;
  const tint = MODE_TINT[modeOf(board)];
  const open = navigation?.openWorkspace;
  const listed = cardAgents(agents, owner);
  return (
    <View style={{ ...ring(colors), backgroundColor: colors.surface1 }}>
      {/* Every card sits on the card grey; its mode lays a very faint tint over the whole card (Manual has none). */}
      {tint ? <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 6, backgroundColor: tint }} /> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${workspace.name}`} disabled={!open} onPress={() => open?.({ workspaceId: workspace.id, serverId: hostId })}
        style={(state) => ({ paddingHorizontal: 12, paddingVertical: 10, gap: 8, borderTopLeftRadius: 6, borderTopRightRadius: 6, backgroundColor: isHovered(state) ? colors.surface1 : "transparent" })}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 2 }}>
              {board.conn ? <ConnSign colors={colors} conn={board.conn} now={now} /> : null}
              <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{plainName(workspace.name)}</Text>
              {held ? <Text style={{ color: colors.foregroundMuted, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 5, fontSize: 11, lineHeight: 16 }}>{held}</Text> : null}
            </View>
            <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{[machine, repoName, board.title].filter(Boolean).join(" · ")}</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 10, flexShrink: 0 }}>
            {dots.map((dot) => (
              <View key={dot.kind} accessibilityLabel={dot.label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: dotColor(dot.kind, colors), backgroundColor: dot.kind === "idle" ? "transparent" : dotColor(dot.kind, colors) }} />
                <Text style={{ color: dotColor(dot.kind, colors), fontSize: 12, lineHeight: 18, fontWeight: "600" }}>{dot.label}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 2, height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: segments.length ? "transparent" : colors.surface2 }}>
          {segments.map((segment) => <View key={segment.kind} style={{ flex: segment.flex, ...segmentColor(segment, colors) }} />)}
        </View>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
            {board.totalMin > 0
              ? <><Text style={{ color: colors.foreground, fontWeight: "600" }}>{board.percent}%</Text>{` ${formatWorkDone(board.doneMin, board.totalMin)} done`}</>
              : total ? `${board.done} of ${total} done` : "No objectives yet"}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{[board.open ? `${board.open} open` : "", board.inProgress ? `${board.inProgress} in progress` : ""].filter(Boolean).join(" · ")}</Text>
        </View>
        {chips.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
            {chips.map((chip) => <Text key={chip} style={{ color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 4, paddingHorizontal: 5, fontSize: 11, lineHeight: 16, fontWeight: "600" }}>{chip}</Text>)}
            {lower ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{lower}</Text> : null}
          </View>
        ) : null}
        {board.now ? (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
            <View style={{ paddingTop: 4 }}>{stale ? <StalledPulse color={colors.statusWarning} size={10} /> : <Spinner color={colors.accent} size={10} />}</View>
            <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 12, lineHeight: 18 }}>
              {[`${board.now.id} ${board.now.title}`, board.now.stage, formatAgo(board.now.since, now)].filter(Boolean).join(" · ")}{board.now.more ? ` (+${board.now.more} more)` : ""}
            </Text>
          </View>
        ) : null}
      </Pressable>
      {ready.total ? (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6, paddingBottom: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingBottom: 6 }}>
            <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 11, lineHeight: 16, fontWeight: "600" }}>Open · {ready.total}</Text>
            <Text style={{ color: AUTO_BLUE, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>∞</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>P0–P2 run in full auto</Text>
          </View>
          {ready.items.map((item) => (
            <View key={item.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingLeft: 12 + item.depth * 16, paddingRight: 12, paddingVertical: 5, borderTopWidth: 1, borderTopColor: colors.border }}>
              {/* Same mark as the panel: a still dot, or a ">" on a nested row so a child hangs off the row above. */}
              {item.working
                ? <View style={{ width: 12, paddingTop: 4, alignItems: "center" }}><View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.statusWarning }} /></View>
                : item.depth > 0
                ? <View style={{ width: 12, paddingTop: 3, alignItems: "center" }}><Icon name="ChevronRight" size={12} color={colors.foregroundMuted} /></View>
                : <View style={{ width: 12, paddingTop: 7, alignItems: "center" }}><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.foregroundMuted, opacity: 0.5 }} /></View>}
              <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, lineHeight: 18 }}>
                {item.auto ? <Text style={{ color: AUTO_BLUE, fontWeight: "600" }}>∞ </Text> : null}
                <Text style={{ color: colors.foregroundMuted, ...mono }}>{item.id}</Text>{`  ${item.title} `}
                <Text style={{ color: colors.foregroundMuted, backgroundColor: colors.surface2, borderRadius: 3, fontSize: 10, lineHeight: 14, fontWeight: "600" }}>{` P${item.priority} `}</Text>
              </Text>
            </View>
          ))}
          {ready.more ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAll }} onPress={() => setShowAll((current) => !current)}
              style={(state) => ({ paddingHorizontal: 12, paddingVertical: 3, backgroundColor: isHovered(state) ? colors.surface2 : "transparent" })}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{ready.more}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ModeSelector colors={colors} entry={entry} ownerName={ownerName} ownerId={owner?.id} />
      {listed.length || !agents.length ? (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 4 }}>
          {listed.length
            ? listed.map((agent) => <AgentRow key={agent.id} colors={colors} agent={agent} owner={agent.id === owner?.id} navigation={navigation} hostId={hostId} />)
            : <Text style={{ paddingHorizontal: 12, paddingVertical: 3, color: colors.foregroundMuted, opacity: 0.7, fontSize: 12, lineHeight: 18 }}>No agents</Text>}
        </View>
      ) : null}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 8, paddingVertical: 4 }}>
        <ArchiveButton colors={colors} label run={() => paseo.workspaces.archive(workspace.id)}
          target={{ kind: "workspace", name: workspace.name, agents: agents.length, running: agents.filter(isWorking).length, board: board.title ?? workspace.name }} />
      </View>
    </View>
  );
}

// The repo's workspaces that have agents and no board.
export function ChatsCard({ colors, entries, navigation, hostId }: { colors: Colors; entries: WorkspaceEntry[]; navigation: Navigation; hostId: string }) {
  const agents = entries.reduce((sum, entry) => sum + entry.agents.length, 0);
  const paseo = usePaseo();
  return (
    <View style={{ ...ring(colors), backgroundColor: colors.surface1 }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 1 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>Agents without a board</Text>
        <Text style={{ color: colors.foregroundMuted, opacity: 0.8, fontSize: 12, lineHeight: 17 }}>{`${agents} ${agents === 1 ? "agent" : "agents"} · ${entries.length} ${entries.length === 1 ? "chat" : "chats"}`}</Text>
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 4 }}>
        {entries.map((entry) => (
          <View key={entry.workspace.id}>
            <View style={{ flexDirection: "row", alignItems: "center", paddingRight: 6 }}>
              <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 2, color: colors.foregroundMuted, opacity: 0.8, fontSize: 12, lineHeight: 17 }}>{entry.workspace.name}</Text>
              <ArchiveButton colors={colors} run={() => paseo.workspaces.archive(entry.workspace.id)}
                target={{ kind: "workspace", name: entry.workspace.name, agents: entry.agents.length, running: entry.agents.filter(isWorking).length, board: null }} />
            </View>
            {entry.agents.map((agent) => <AgentRow key={agent.id} colors={colors} agent={agent} owner={false} navigation={navigation} hostId={hostId} indent={20} archive={() => paseo.agents.ref(agent.id).archive()} />)}
          </View>
        ))}
      </View>
    </View>
  );
}
