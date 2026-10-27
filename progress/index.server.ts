import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleGetBeads, handleGetBeadDetail, handleSetBeadStatus, handleUpgradeBead } from "./server/beads";
import { handleGetAttention, handleGetDashboard, handleGetOverview, handleListFolders, handleMarkPanelOpened, handleSetBoardMode, handleSetHistoryFolder } from "./server/dashboard";
import { handleGetAllHostsOverview } from "./server/everything";
import { handleInstallLauncher, handleLauncherStatus } from "./server/launcher";
import { ensureBoardsLauncher } from "./server/launcher";
import { handleOpenDeliverable, handlePreviewDeliverable } from "./server/open";
import { handleReportPerf } from "./server/perf";
import { handleInstallSkill, handleSkillStatus } from "./server/skill";
import { getAttention, getOverview, getAllHostsOverview, getBeadDetail, getBeads, getDashboard, getLauncherStatus, getSkillStatus, installLauncher, installSkill, listFolders, markPanelOpened, openDeliverable, previewDeliverable, setBeadStatus, setBoardMode, setHistoryFolder, upgradeBead, reportPerf } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  // Every box's harness boards endpoint runs the reader this plugin writes. A box
  // that runs the plugin but never pressed Install has none, so ensure it here.
  // Never under test, and never blocking: a failure leaves the plugin working.
  if (!process.env.NODE_TEST_CONTEXT) void ensureBoardsLauncher();
  server.handle(getDashboard, handleGetDashboard);
  server.handle(getAttention, handleGetAttention);
  server.handle(getOverview, handleGetOverview);
  server.handle(getAllHostsOverview, handleGetAllHostsOverview);
  server.handle(getBeads, handleGetBeads);
  server.handle(getBeadDetail, handleGetBeadDetail);
  server.handle(setBeadStatus, handleSetBeadStatus);
  server.handle(upgradeBead, handleUpgradeBead);
  server.handle(markPanelOpened, handleMarkPanelOpened);
  server.handle(reportPerf, handleReportPerf);
  server.handle(getLauncherStatus, handleLauncherStatus);
  server.handle(installLauncher, handleInstallLauncher);
  server.handle(openDeliverable, handleOpenDeliverable);
  server.handle(previewDeliverable, handlePreviewDeliverable);
  server.handle(getSkillStatus, handleSkillStatus);
  server.handle(installSkill, handleInstallSkill);
  server.handle(listFolders, handleListFolders);
  server.handle(setBoardMode, handleSetBoardMode);
  server.handle(setHistoryFolder, handleSetHistoryFolder);
  return () => {};
}
