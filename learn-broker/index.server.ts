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
import { startBrokerCore, type BrokerCore } from "./server/broker-core.ts";
import {
	createPaseoBrokerAdapter,
	type PaseoSdkApi,
} from "./server/paseo-adapter.ts";

/** The file-bridge config source: the service /mcp URL is required for
 *  child creation; the Authorization header is derived from the service
 *  token and OMITTED when unset — the bridge never carries a half
 *  credential (the P4 law, mirrored). */
function resolveBridgeFromEnv() {
	const url = process.env.LEARN_SERVICE_URL;
	if (!url) throw new Error("learn-broker: LEARN_SERVICE_URL is not configured");
	return {
		mcpServers: {
			learn: {
				type: "http" as const,
				url,
				...(process.env.LEARN_SERVICE_TOKEN
					? { headers: { Authorization: `Bearer ${process.env.LEARN_SERVICE_TOKEN}` } }
					: {}),
			},
		},
	};
}

export default function contribute(server: PluginServerContext) {
	let core: BrokerCore | null = null;
	let starting = false;

	const begin = (paseo: PaseoSdkApi): void => {
		if (core || starting) return;
		starting = true;
		startBrokerCore({
			token: process.env.LEARN_BROKER_TOKEN ?? null,
			logDir: process.env.LEARN_BROKER_LOG_DIR,
			host: process.env.LEARN_BROKER_HOST,
			port: createPaseoBrokerAdapter(paseo, {
				provider: process.env.LEARN_BROKER_PROVIDER,
				resolveBridge: resolveBridgeFromEnv,
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
