import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { BeadsResult } from "../shared/rpc.ts";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// The read-only Beads tab: one row per recorded bead — priority pill, muted
// mono id, title, status. Beads stays the record; this only shows it. No
// buttons, no promotion. Every state is calm: `none` says so in one line,
// an error says what went wrong, and an absent result says nothing at all —
// never a spinner and never a stack.
export function BeadsView({ colors, result }: { colors: Colors; result: BeadsResult | null | undefined }) {
  if (!result) return null;
  if (result.state !== "ok") {
    return (
      <View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          {result.state === "none" ? "No beads in this repo" : result.message}
        </Text>
      </View>
    );
  }
  return (
    <View>
      {/* An ok read with zero beads says so in its own calm line — never
          nothing (proof fix D-3); distinct from the none text. */}
      {result.issues.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>No open beads</Text>
      ) : (
        result.issues.map((issue) => (
        <View key={issue.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border }}>
          {issue.priority !== undefined ? (
            <View style={{ minWidth: 18, paddingHorizontal: 4, borderRadius: 4, alignItems: "center", backgroundColor: colors.surface2 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 10, lineHeight: 14, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{`P${issue.priority}`}</Text>
            </View>
          ) : null}
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, fontFamily: "monospace" }}>{issue.id}</Text>
          <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 18, flexShrink: 1 }}>{issue.title}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{issue.status}</Text>
        </View>
        ))
      )}
    </View>
  );
}
