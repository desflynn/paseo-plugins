import { useEffect, useState, type ReactNode } from "react";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { BeadDialog } from "./bead-dialog";
import { BeadsTab } from "./beads";
import type { BeadDetailResult, BeadStatus, BeadsResult } from "../shared/rpc.ts";
import { getBeadDetail, getBeads, setBeadStatus, upgradeBead } from "../shared/rpc.ts";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

// The Beads tab's live glue (T13 / O2200): opens the sheet, fetches the
// record, writes the status and the upgrade, and refreshes the list after a
// write so the tab stays truthful. Since O2600 it also owns the done-sink's
// shown state. The panel hands in the workspace identity; this component
// replaces the pure BeadsView in the panel's beadsTab() once that identity is
// passed through.
type UpgradeResult = { state: "ok"; ticketId: string | null } | { state: "none" } | { state: "error"; message: string };

// One line for the sheet: the objective the press made, or why it made none.
function promoteNotice(result: UpgradeResult): string {
  if (result.state === "ok") return result.ticketId ? `Promoted as ${result.ticketId}` : "Promoted as a new objective";
  if (result.state === "none") return "No beads database here, so nothing was promoted";
  return `Not promoted: ${result.message}`;
}

export function BeadsSheet({ colors, result, workspaceId, workspaceDirectory }: {
  colors: Colors;
  result: BeadsResult | null | undefined;
  workspaceId: string;
  workspaceDirectory: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BeadDetailResult | null>(null);
  const [busy, setBusy] = useState(false);
  // What the last Promote did, in words: the new objective's id, or why not.
  const [notice, setNotice] = useState<string | undefined>();
  // The done-sink's state (O2600): the fold opens and folds back from here.
  const [foldShown, setFoldShown] = useState(false);
  // A write swaps the tab over to its own fresh read, so a status change
  // shows at once; the panel's next changed periodic read takes over again.
  const [refreshed, setRefreshed] = useState<BeadsResult | null>(null);
  useEffect(() => setRefreshed(null), [result]);
  const fetchDetail = useRpc(getBeadDetail);
  const writeStatus = useRpc(setBeadStatus);
  const runUpgrade = useRpc(upgradeBead);
  const fetchList = useRpc(getBeads);
  const shown = refreshed ?? result;
  const readDetail = (beadId: string) =>
    fetchDetail({ workspaceId, workspaceDirectory, id: beadId })
      .then((read) => setDetail(read as BeadDetailResult))
      .catch(() => setDetail({ state: "error", message: "Could not read the bead" }));
  const open = (beadId: string) => {
    setOpenId(beadId);
    setNotice(undefined);
    setDetail(null);
    void readDetail(beadId);
  };
  const settle = (beadId: string) => {
    setBusy(false);
    void readDetail(beadId);
    fetchList({ workspaceId, workspaceDirectory })
      .then((next) => setRefreshed(next as BeadsResult))
      .catch(() => {});
  };
  const onSetStatus = (status: BeadStatus) => {
    if (!openId) return;
    setBusy(true);
    writeStatus({ workspaceId, workspaceDirectory, id: openId, status })
      .catch(() => {})
      .then(() => settle(openId));
  };
  const onUpgrade = () => {
    if (!openId) return;
    setBusy(true);
    setNotice(undefined);
    runUpgrade({ workspaceId, workspaceDirectory, id: openId })
      .then((result) => setNotice(promoteNotice(result as UpgradeResult)))
      .catch((error) => setNotice(`Could not promote: ${error instanceof Error ? error.message : String(error)}`))
      .then(() => settle(openId));
  };
  return (
    <BeadsTab
      colors={colors}
      result={shown}
      onOpenBead={open}
      foldShown={foldShown}
      onToggleFold={() => setFoldShown(!foldShown)}
      dialog={
        <BeadDialog
          colors={colors}
          beadId={openId}
          detail={detail}
          busy={busy}
          notice={notice}
          onClose={() => setOpenId(null)}
          onSetStatus={onSetStatus}
          onUpgrade={onUpgrade}
        />
      }
    />
  );
}
