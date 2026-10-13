import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import type { BeadDetailResult, BeadStatus } from "../shared/rpc.ts";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// Every status bd advertises that a person drives from the sheet. The bead's
// current status is never offered again; pinned and hooked stay bd's own —
// they are agent states, not buttons.
const SHEET_STATUSES: readonly BeadStatus[] = ["open", "in_progress", "blocked", "deferred", "closed"];

// The bead detail sheet (T13 / O2200): what the bead is on top, the actions
// at the bottom. Pure — the tab's glue fetches the record and hands it in.
// Every state stays calm: reading says so in one line, an error says what
// went wrong and offers nothing, and no bead open means no sheet at all.
export function BeadDialog({ colors, beadId, detail, busy, notice, promotedAs, onClose, onSetStatus, onUpgrade }: {
  colors: Colors;
  beadId: string | null;
  detail: BeadDetailResult | null | undefined;
  busy: boolean;
  // What the last press did: the promoted id, or why it was refused.
  notice?: string;
  // The objective this bead already became: shown as a chip, and the bead
  // is not offered for promotion a second time.
  promotedAs?: string;
  onClose(): void;
  onSetStatus(status: BeadStatus): void;
  onUpgrade(): void;
}) {
  if (!beadId) return null;
  const bead = detail?.state === "ok" ? detail.bead : null;
  const record: Array<[string, string | undefined]> = [
    ["Owner", bead?.owner],
    ["Created by", bead?.created_by],
    ["Created", bead?.created_at],
    ["Closed", bead?.closed_at],
  ];
  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.surface0, padding: 12, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, fontFamily: "monospace" }}>{beadId}</Text>
        {bead ? <Text style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>{bead.title}{promotedAs ? " " : null}{promotedAs ? <Text style={{ backgroundColor: colors.surface2, color: colors.foregroundMuted, fontSize: 10, fontWeight: "600" }}>{promotedAs}</Text> : null}</Text> : <View style={{ flex: 1 }} />}
        <Pressable accessibilityRole="button" accessibilityLabel="Close bead detail" onPress={onPress(onClose, busy)}
          style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>Close</Text>
        </Pressable>
      </View>

      {!detail || detail.state !== "ok" ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          {detail?.state === "error" ? detail.message : "Reading the bead…"}
        </Text>
      ) : (
        <View style={{ gap: 10 }}>
          {bead?.description ? <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{bead.description}</Text> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {bead?.priority !== undefined ? (
              <View style={{ minWidth: 18, paddingHorizontal: 4, borderRadius: 4, alignItems: "center", backgroundColor: colors.surface2 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 10, lineHeight: 14, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{`P${bead.priority}`}</Text>
              </View>
            ) : null}
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{bead?.status}</Text>
            {bead?.issue_type ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{bead.issue_type}</Text> : null}
          </View>
          {record.filter(([, value]) => value !== undefined).map(([label, value]) => (
            <Text key={label} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{`${label}: `}<Text style={{ color: colors.foreground }}>{value}</Text></Text>
          ))}
          {bead?.close_reason ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{"Close reason: "}<Text style={{ color: colors.foreground }}>{bead.close_reason}</Text></Text> : null}
        </View>
      )}

      {/* Right under the details, not pinned to the panel bottom: on a tall or phone panel that left the buttons off screen. */}
      {bead ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {SHEET_STATUSES.filter((status) => status !== bead.status).map((status) => (
              <Pressable key={status} accessibilityRole="button" accessibilityLabel={`Set status ${status}`} onPress={onPress(() => onSetStatus(status), busy)}
                style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, borderWidth: 1, borderColor: colors.border }}>
                <Text style={{ color: colors.foreground, fontSize: 12, lineHeight: 17 }}>{status}</Text>
              </Pressable>
            ))}
          </View>
          {promotedAs ? null : (
            <Pressable accessibilityRole="button" accessibilityLabel="Promote to objective" onPress={onPress(onUpgrade, busy)}
              style={{ paddingHorizontal: 8, paddingVertical: 6, borderRadius: 4, borderWidth: 1, borderColor: colors.border }}>
              <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>Promote to objective</Text>
            </Pressable>
          )}
          {notice ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foreground, fontSize: 12, lineHeight: 17 }}>{notice}</Text> : null}
          {busy ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Working…</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

// While a write is in flight the buttons keep their press but do nothing,
// so a double-tap cannot queue two writes.
function onPress(apply: () => void, busy: boolean) {
  return busy ? () => {} : apply;
}
