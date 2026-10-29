/**
 * learn-broker plugin shell (learn-on-paseo P5 wave 3, Part B). Thin by
 * law: it captures the authenticated paseo handle from the first hook
 * context the daemon delivers, then starts the broker core with the token
 * from the env seam. No protocol, no adapter logic — those live in
 * server/broker-core.ts and server/paseo-adapter.ts.
 *
 * Token pairing (Part B.1): the broker token is generated once at setup
 * and shown as a pairing string; it is pasted into the SERVICE's env as
 * LEARN_BROKER_TOKEN and into the plugin's env here (same value both
 * sides). It is never git, never an agent prompt, never the daemon
 * password. No token configured → the core refuses to start (fail-closed)
 * and the plugin logs the refusal.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleLearnConversation, handleLearnOverview } from "./server/overview.ts";
import { learnOverview, learnStartConversation } from "./shared/rpc.ts";
import { startBrokerCore, type BrokerCore } from "./server/broker-core.ts";
import { isWorldReadable, resolveSettings, type BrokerSettings } from "./server/config.ts";
import {
	createPaseoBrokerAdapter,
	type PaseoSdkApi,
} from "./server/paseo-adapter.ts";

/** The file-bridge config source: the service /mcp URL is required for
 *  child creation; the Authorization header is derived from the service
 *  token and OMITTED when unset — the bridge never carries a half
 *  credential (the P4 law, mirrored). */
function resolveBridge(settings: BrokerSettings) {
	const url = settings.serviceUrl;
	if (!url) {
		throw new Error(
			`learn-broker: no service URL configured — set serviceUrl in ${settingsPathHint} or LEARN_SERVICE_URL`,
		);
	}
	return {
		mcpServers: {
			learn: {
				type: "http" as const,
				url,
				...(settings.serviceToken
					? { headers: { Authorization: `Bearer ${settings.serviceToken}` } }
					: {}),
			},
		},
	};
}

const settingsPathHint = "~/.learnharness/learn-broker.env";

export default function contribute(server: PluginServerContext) {
	let core: BrokerCore | null = null;
	let starting = false;

	const begin = (paseo: PaseoSdkApi): void => {
		if (core || starting) return;
		starting = true;
		// Settings come from the environment, then ~/.learnharness/learn-broker.env,
		// then the defaults. Paseo has no per-plugin env seam, so the file is the
		// home and the environment stays an override. The token is never logged.
		// F5 (fail-closed, wired at startup): a world-readable settings file
		// refuses to start — the pairing token lives in it.
		if (isWorldReadable()) {
			console.error(
				`learn-broker: refusing to start — ${settingsPathHint} is world-readable (chmod 0600 it; the pairing token lives there)`,
			);
			starting = false;
			return;
		}
		const settings = resolveSettings();
		startBrokerCore({
			token: settings.token,
			logDir: settings.logDir,
			host: settings.host,
			listenPort: settings.port,
			port: createPaseoBrokerAdapter(paseo, {
				provider: settings.provider,
				resolveBridge: () => resolveBridge(settings),
			}),
		})
			.then((started) => {
				core = started;
				console.log(`learn-broker: listening on ${JSON.stringify(started.address())}`);
			})
			.catch((err: unknown) => {
				console.error("learn-broker: failed to start (fail-closed):", err);
			});
	};

	// The Learn page's reads: the six-route envelope and the conversation
	// mint. Both fetch the service with the token from the env seam; the
	// token never crosses this boundary.
	server.handle(learnOverview, handleLearnOverview);
	server.handle(learnStartConversation, handleLearnConversation);

	// The plugin contracts deliver the authenticated PaseoApi via hook
	// contexts; capture it from the first event and start once.
	server.on("agent.created", (_event, { paseo }) => begin(paseo));
	server.on("agent.turn_ended", (_event, { paseo }) => begin(paseo));

	return () => {
		const closing = core;
		core = null;
		if (closing) void closing.close();
	};
}
