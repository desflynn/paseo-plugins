import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleGetBeads, handleGetBeadDetail, handleSetBeadStatus, handleUpgradeBead } from "./server/beads";
import { handleGetAttention, handleGetDashboard, handleListFolders, handleMarkPanelOpened, handleSetHistoryFolder } from "./server/dashboard";
import { handleInstallLauncher, handleLauncherStatus } from "./server/launcher";
import { handleOpenDeliverable, handlePreviewDeliverable } from "./server/open";
import { handleReportPerf } from "./server/perf";
import { handleInstallSkill, handleSkillStatus } from "./server/skill";
import { getAttention, getBeadDetail, getBeads, getDashboard, getLauncherStatus, getSkillStatus, installLauncher, installSkill, listFolders, markPanelOpened, openDeliverable, previewDeliverable, setBeadStatus, setHistoryFolder, upgradeBead, reportPerf } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(getDashboard, handleGetDashboard);
  server.handle(getAttention, handleGetAttention);
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
  server.handle(setHistoryFolder, handleSetHistoryFolder);
  return () => {};
}
