import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PROGRESS_SCREEN_ID, ProgressOverviewScreen, ProgressSidebarItem } from "./client/overview";
import { ProgressPanel } from "./client/panel";
import { contributePills, progressPanel } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  const stopPills = contributePills(client);
  const panel = progressPanel();
  const stopPanel = client.addWorkspacePanel({
    id: panel.id,
    title: "Progress",
    icon: "ListChecks",
    context: "workspace",
    locations: [panel.location],
    Component: ProgressPanel,
  });
  const stopCommand = client.addCommandCenterItem({
    id: "open-progress",
    title: "Open Progress",
    icon: "ListChecks",
    keywords: ["dashboard", "tickets", "status", "questions"],
    context: "workspace",
    // Beside the agent chat where Paseo can show both; a tab of its own on phones.
    onSelect({ openPanel }) {
      openPanel(panel.id, { location: panel.location });
    },
  });

  const stopScreen = client.addScreen({ id: PROGRESS_SCREEN_ID, title: "Progress", Component: ProgressOverviewScreen });
  const stopSidebar = client.addSidebarHeaderItem({ id: "progress", title: "Progress", Component: ProgressSidebarItem });

  return () => {
    void stopScreen();
    void stopSidebar();
    void stopPanel();
    void stopCommand();
    stopPills();
  };
}
