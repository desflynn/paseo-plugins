import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import type { BoardStatus, CloseReason } from "../shared/events";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// The Beads vocabulary, worded for people. A closed ticket reads as its
// reason: Done, or Skipped.
export function statusLabel(status: BoardStatus, closeReason?: CloseReason): string {
  if (status === "closed") return closeReason === "skipped" ? "Skipped" : "Done";
  return { open: "Open", in_progress: "In progress", blocked: "Blocked" }[status];
}

// `waiting`: held for another ticket. Shown as calm as "Open", whatever the status.
export function StatusBadge({ colors, status, closeReason, waiting = false }: { colors: Colors; status: BoardStatus; closeReason?: CloseReason; waiting?: boolean }) {
  const tone = waiting ? { fg: colors.foregroundMuted, bg: "transparent", border: colors.border } : status === "closed"
    ? (closeReason === "skipped"
      ? { fg: colors.foregroundMuted, bg: "transparent", border: colors.border }
      : { fg: colors.statusSuccess, bg: "transparent", border: colors.statusSuccess })
    : {
        in_progress: { fg: colors.accentForeground, bg: colors.accent, border: colors.accent },
        blocked: { fg: colors.statusDanger, bg: "transparent", border: colors.statusDanger },
        open: { fg: colors.foregroundMuted, bg: "transparent", border: colors.border },
      }[status];
  return (
    <View style={{ borderWidth: 1, borderColor: tone.border, backgroundColor: tone.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color: tone.fg, fontSize: 11, lineHeight: 16 }}>{waiting ? "Waiting" : statusLabel(status, closeReason)}</Text>
    </View>
  );
}
