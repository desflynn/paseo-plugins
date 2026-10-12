import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { formatEstimate } from "../shared/format";
import type { RowTone } from "../shared/dashboard.ts";
import { Spinner, WaitingDot } from "./spinner";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// O2600 (o17): one shared list for the three panel views. Objectives, beads
// and GitHub issues render through UnifiedList (open rows, then the
// done-sink, then whatever the fold reveals) in UnifiedRow's one style. The
// pieces here are hook-free, so the tree tests inspect them directly; the
// fold's shown state lives with the callers' glue.

// How far open-but-not-started rows sit back: 66% foreground (owner ruling:
// 75% left too little differential between running and open).
export const POTENTIAL_OPACITY = 0.66;

// The not-running mark, one for every tab: the still, faded dot, or a ">" on
// a nested row (owner ruling) so a child reads as hanging off the row above.
export function PendingMark({ colors, nested = false }: { colors: Colors; nested?: boolean }) {
  return nested
    ? <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
    : <WaitingDot color={colors.foregroundMuted} size={14} />;
}

// The status mark for views without a live read (beads, GH): same slot, same
// icon language as the objectives' rows, drawn from the bead's own status.
export function UnifiedStatusIcon({ colors, status, nested = false }: { colors: Colors; status: string; nested?: boolean }) {
  switch (status) {
    case "closed":
      return <Icon name="Check" size={14} color={colors.statusSuccess} />;
    case "in_progress":
      return <Spinner color={colors.accent} size={14} />;
    case "blocked":
      return <Icon name="Ban" size={14} color={colors.statusDanger} />;
    default:
      // Open, deferred, anything not running.
      return <PendingMark colors={colors} nested={nested} />;
  }
}

// One row for all three views. Slots line up down the list: the status mark,
// the tight id + title, the priority pill, the row's detail lines, its chips
// — then, only on the objectives, the deliverables slot and the estimate.
// Beads and GH rows carry no time element; nothing is invented for them.
export function UnifiedRow({ colors, icon, iconLabel, id, title, tone, dim = tone === "potential", strike = false, priority, detail, chips, estimateMin, deliverables, onOpen, accessibilityLabel, narrow = false, depth = 0 }: {
  colors: Colors;
  // The status mark in the slot every view shares; the label carries the
  // status word for reading.
  icon: React.ReactNode;
  iconLabel?: string;
  id: string;
  title: string;
  // Running vs potential (owner ruling 4).
  tone: RowTone;
  // Potential rows sit muted; a closed row opts out (its fold carries it).
  dim?: boolean;
  // A skipped close keeps its line through.
  strike?: boolean;
  priority?: number;
  detail?: React.ReactNode;
  chips?: React.ReactNode;
  // The time element: objectives only.
  estimateMin?: number;
  deliverables?: number;
  onOpen?(): void;
  accessibilityLabel?: string;
  narrow?: boolean;
  depth?: number;
}) {
  const row = (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: narrow ? 6 : 10, paddingLeft: 10 + depth * 16, paddingRight: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
      <View accessible={Boolean(iconLabel)} accessibilityLabel={iconLabel} style={{ width: 16, paddingTop: 2, alignItems: "center", marginRight: narrow ? 2 : 0 }}>
        {icon}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color: strike ? colors.foregroundMuted : colors.foreground, fontSize: 13, lineHeight: 18, fontWeight: tone === "running" ? "600" : "400", opacity: dim ? POTENTIAL_OPACITY : 1, textDecorationLine: strike ? "line-through" : "none" }}>
          {id}  {title}
        </Text>
        {priority !== undefined ? (
          <View style={{ alignSelf: "flex-start", minWidth: 18, paddingHorizontal: 4, borderRadius: 4, alignItems: "center", backgroundColor: colors.surface2 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 10, lineHeight: 14, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{`P${priority}`}</Text>
          </View>
        ) : null}
        {detail}
        {chips}
      </View>
      {/* Fixed slots so the Package icon and the estimates line up down the
          objectives list. Rows without a time element stop before them. */}
      {estimateMin === undefined ? null : (
        <>
          <View accessibilityLabel={deliverables ? (deliverables === 1 ? "Has a deliverable" : `Has ${deliverables} deliverables`) : undefined} style={{ width: 12, height: 18, justifyContent: "center" }}>
            {deliverables ? <Icon name="Package" size={12} color={colors.foregroundMuted} /> : null}
          </View>
          <Text style={{ minWidth: 40, flexShrink: 0, textAlign: "right", color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontVariant: ["tabular-nums"] }}>{formatEstimate(estimateMin)}</Text>
        </>
      )}
      {onOpen && !narrow ? <View style={{ paddingTop: 2 }}><Icon name="ChevronRight" size={14} color={colors.foregroundMuted} /></View> : null}
    </View>
  );
  if (!onOpen) return row;
  // Press for the row's story. Hook-free on purpose — these rows render in
  // the tree tests — so the tint reads the press only: one surface up, two
  // for a working row resting on surface1. (The hover tint stays on the
  // hookful rows in row.tsx.)
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onOpen}
      style={({ pressed }) => [row.props.style as object, { backgroundColor: pressed ? (tone === "running" ? colors.border : colors.surface2) : "transparent" }]}>
      {row.props.children}
    </Pressable>
  );
}

// The done-sink's collapsed count header (the objectives' "7 done" row,
// generalised): what folded, how much finished clean for the icon, the fold's
// total estimate when the view carries hours — objectives only — and the
// chevron pointing the way the list will move. Openable wherever the caller
// hands an onPress; never a dead count.
export function DoneSinkRow({ colors, label, done, estimateMin, shown, onPress, narrow = false }: {
  colors: Colors;
  label: string;
  done: number;
  estimateMin?: number;
  shown: boolean;
  onPress?(): void;
  narrow?: boolean;
}) {
  const chevron = shown ? "ChevronUp" : "ChevronDown";
  const body = (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
      <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}>
        <Icon name={done ? "Check" : "CircleSlash"} size={14} color={done ? colors.statusSuccess : colors.foregroundMuted} />
      </View>
      <Text style={{ flex: 1, minWidth: 0, color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{label}</Text>
      {estimateMin === undefined ? null : (
        <>
          {/* Narrow rows drop the chevron, so this total would sit off their estimate column. */}
          {narrow ? null : <View style={{ width: 12 }} />}
          <Text style={{ minWidth: 40, flexShrink: 0, textAlign: "right", color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontVariant: ["tabular-nums"] }}>{formatEstimate(estimateMin)}</Text>
        </>
      )}
      <View style={{ paddingTop: 2 }}>
        <Icon name={chevron} size={14} color={colors.foregroundMuted} />
      </View>
    </View>
  );
  if (!onPress) return body;
  // Hook-free like the row above: the press tints, one surface up.
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: shown }}
      accessibilityLabel={`${shown ? "Hide" : "Show"} ${label}`} onPress={onPress}
      style={({ pressed }) => [body.props.style as object, { backgroundColor: pressed ? colors.surface2 : "transparent" }]}>
      {body.props.children}
    </Pressable>
  );
}

// The shared list: the open rows, then the done-sink's count header, then —
// only while it's shown — the folded rows, then the view's dialog. Empty
// views get the one calm line. The fold rule itself stays pure in shared/
// (finishedToFold, beadsToFold); this only renders what the caller worked out.
export function UnifiedList({ colors, openRows, closedRows, foldLabel, foldDone = 0, foldEstimateMin, shown, onToggleFold, empty, dialog, narrow = false }: {
  colors: Colors;
  openRows: React.ReactNode[];
  closedRows: React.ReactNode[];
  // The fold's count label; empty or absent means nothing folds.
  foldLabel?: string;
  foldDone?: number;
  foldEstimateMin?: number;
  shown: boolean;
  onToggleFold?(): void;
  empty: string;
  dialog?: React.ReactNode;
  narrow?: boolean;
}) {
  if (!openRows.length && !closedRows.length) {
    return (
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
        {empty}
      </Text>
    );
  }
  return (
    <View>
      {openRows}
      {foldLabel ? <DoneSinkRow colors={colors} label={foldLabel} done={foldDone} estimateMin={foldEstimateMin} shown={shown} onPress={onToggleFold} narrow={narrow} /> : null}
      {foldLabel && shown ? closedRows : null}
      {dialog}
    </View>
  );
}
