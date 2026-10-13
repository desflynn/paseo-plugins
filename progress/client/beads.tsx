import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { beadDoneLabel, beadsToFold, compareBeads, nestBeads, rowTone, type NestedBead } from "../shared/dashboard.ts";
import type { BeadIssue, BeadsResult } from "../shared/rpc.ts";
import { UnifiedList, UnifiedRow, UnifiedStatusIcon } from "./unified-list";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// The Beads view: one row per recorded bead, in the panel's one shared row
// style (O2600). Beads stays the record; this only shows it. Since T13
// (O2200) a row taps open the detail sheet, whose actions live at the
// bottom of the sheet; the tab itself still promotes nothing. Since O2600
// the closed beads sink behind a count header that opens — the read carries
// them (`bd list --all`), the fold rule stays pure in shared/. Every state
// is calm: `none` says so in one line, an error says what went wrong, and
// an absent result says nothing at all — never a spinner and never a stack.

// One bead in the shared row: tight id + title on the line, the status mark
// labelled with the status word, the priority pill. Bead rows show the bead's
// own id — never an objective number — and carry no time element.
function BeadRow({ colors, issue, onOpenBead, narrow = false, nested = false, promotedAs }: { colors: Colors; issue: BeadIssue; onOpenBead?(id: string): void; narrow?: boolean; nested?: boolean; promotedAs?: string }) {
  return (
    <UnifiedRow
      colors={colors}
      narrow={narrow}
      icon={<UnifiedStatusIcon colors={colors} status={issue.status} nested={nested} />}
      iconLabel={issue.status}
      id={issue.id}
      title={issue.title}
      tone={rowTone(issue.status)}
      dim={issue.status !== "closed" && issue.status !== "in_progress"}
      strike={issue.status === "closed" && issue.close_reason === "skipped"}
      priority={issue.priority}
      tag={promotedAs}
      italic={promotedAs !== undefined}
      onOpen={onOpenBead ? () => onOpenBead(issue.id) : undefined}
      accessibilityLabel={`Open bead ${issue.id}`}
    />
  );
}

// O3000 (o30): the nested rows as nodes — one path shared by BeadRows and
// the tab's buckets, so the sheet and the pure view nest identically. A
// child renders indented under its epic, recursively, in the shared row style.
function renderBeadFamily(colors: Colors, entry: NestedBead<BeadIssue>, onOpenBead?: (id: string) => void, narrow = false, nested = false, promoted?: ReadonlyMap<string, string>): ReactNode {
  return (
    <View key={entry.issue.id}>
      <BeadRow colors={colors} issue={entry.issue} onOpenBead={onOpenBead} narrow={narrow} nested={nested} promotedAs={promoted?.get(entry.issue.id)} />
      {entry.children.length ? (
        <View style={{ paddingLeft: 18 }}>
          {entry.children.map((child) => renderBeadFamily(colors, child, onOpenBead, narrow, true, promoted))}
        </View>
      ) : null}
    </View>
  );
}

function nestedRowNodes(colors: Colors, issues: BeadIssue[], onOpenBead?: (id: string) => void, narrow = false, promoted?: ReadonlyMap<string, string>): ReactNode[] {
  return nestBeads(issues).map((entry) => renderBeadFamily(colors, entry, onOpenBead, narrow, false, promoted));
}

// The rows themselves: pressable only when a detail handler is wired (the
// live glue in beads-sheet.tsx hands one in). Without one they render
// exactly as calm, press-free rows.
export function BeadRows({ colors, issues, onOpenBead, narrow = false, promoted }: { colors: Colors; issues: BeadIssue[]; onOpenBead?(id: string): void; narrow?: boolean; promoted?: ReadonlyMap<string, string> }) {
  return (
    <View>
      {nestedRowNodes(colors, issues, onOpenBead, narrow, promoted)}
    </View>
  );
}

// The tab body: pure, so the element tree stays inspectable in tests. The
// sheet arrives as a node from the glue (beads-sheet.tsx), which also owns
// the fold's shown state and hands it in here.
export function BeadsTab({ colors, result, dialog, onOpenBead, foldShown = false, onToggleFold, promoted }: {
  colors: Colors;
  // Bead id -> the objective it became; those rows carry the chip and italics.
  promoted?: ReadonlyMap<string, string>;
  result: BeadsResult | null | undefined;
  dialog?: ReactNode;
  onOpenBead?(id: string): void;
  // The done-sink's state lives with the caller; the pure view renders folded.
  foldShown?: boolean;
  onToggleFold?(): void;
}) {
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
  const sorted = [...result.issues].sort(compareBeads);
  const fold = beadsToFold(sorted);
  const open = sorted.filter((issue) => issue.status !== "closed");
  // Everything closed: no fold row — the whole list is the record, the same
  // law the objectives' fold follows.
  const closed = fold.length ? fold : open.length ? [] : sorted;
  const openRows = nestedRowNodes(colors, open, onOpenBead, false, promoted);
  const closedRows = nestedRowNodes(colors, closed, onOpenBead, false, promoted);
  return (
    <View>
      {/* An ok read with zero beads says so in its own calm line — never
          nothing (proof fix D-3); distinct from the none text. */}
      <UnifiedList
        colors={colors}
        openRows={openRows}
        closedRows={closedRows}
        foldLabel={fold.length ? beadDoneLabel(fold) : ""}
        foldDone={fold.filter((issue) => issue.close_reason !== "skipped").length}
        shown={foldShown}
        onToggleFold={onToggleFold}
        empty="No open beads"
        dialog={dialog}
      />
    </View>
  );
}

// The pure read-only view, for surfaces without a workspace identity. The
// fold renders collapsed here — no state to open it with; the live sheet is
// the shipped path.
export function BeadsView({ colors, result }: { colors: Colors; result: BeadsResult | null | undefined }) {
  return <BeadsTab colors={colors} result={result} />;
}
