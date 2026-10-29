// The Learn plugin's client entry: one sidebar item, one screen, one Command
// Center item — all pointing at the same Learn page. The Command Center opens
// the screen directly (the SDK's command contexts carry openScreen).
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LEARN_SCREEN_ID, LearnScreen, LearnSidebarItem } from "./client/learn.tsx";

export default function contribute(client: PluginClientContext) {
	const stopScreen = client.addScreen({ id: LEARN_SCREEN_ID, title: "Learn", Component: LearnScreen });
	const stopSidebar = client.addSidebarHeaderItem({ id: "learn", title: "Learn", Component: LearnSidebarItem });
	const stopCommand = client.addCommandCenterItem({
		id: "open-learn",
		title: "Open Learn",
		icon: "GraduationCap",
		keywords: ["learn", "graph", "sessions", "spend", "tutor", "conversation"],
		context: "global",
		onSelect({ openScreen }) {
			openScreen({ screenId: LEARN_SCREEN_ID });
		},
	});
	return () => {
		void stopScreen();
		void stopSidebar();
		void stopCommand();
	};
}
