/**
 * Where the broker's settings live.
 *
 * Paseo has no per-plugin environment seam: a plugin's config entry carries only
 * enabled/path/source, `paseo plugin install` has no --env, and a wrapper plugin
 * cannot inject one either — the plugin compiler refuses any module outside the
 * registered plugin directory, and the daemon runs bundled code. The daemon unit
 * is the only other home, and changing it means restarting the daemon.
 *
 * So the plugin reads its own env file, at the path the deployment already plans:
 *
 *   ~/.learnharness/learn-broker.env     chmod 600, never git, never a prompt
 *
 * Format: KEY=VALUE, one per line, as a shell would read it. `#` starts a
 * comment, blank lines are ignored, and one layer of surrounding quotes is
 * stripped. The real environment still wins, so a shell or a test can override
 * any value without touching the file.
 *
 * The binding defaults to loopback. A roaming laptop joins whatever wifi is in
 * range, so a listener on 0.0.0.0 is exposed on every one of those networks.
 * Deployment pins the tailnet address with host= in this file, which is a
 * deliberate choice; 0.0.0.0 is not.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Loopback. Deployment widens this to the tailnet address on purpose. */
export const DEFAULT_HOST = "127.0.0.1";
/** The STABLE default listen port: the address survives a restart, so a
 *  peer can rely on it. LEARN_BROKER_PORT (environment, then the file)
 *  overrides; an explicit 0 still means an ephemeral port. */
export const DEFAULT_PORT = 8790;

export interface BrokerSettings {
	/** The pairing token. Null refuses to start: fail-closed. */
	token: string | null;
	/** The address the listener binds. */
	host: string;
	/** The listen port — the stable 8790 by default; an explicit 0 means
	 *  an ephemeral port. */
	port: number;
	logDir?: string;
	provider?: string;
	serviceUrl?: string;
	serviceToken?: string;
}

export function settingsPath(home = homedir()): string {
	return join(home, ".learnharness", "learn-broker.env");
}

/** A missing or unreadable file is not an error: the environment or the defaults stand. */
export function readEnvFile(path = settingsPath()): Record<string, string> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	const values: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
		const equals = withoutExport.indexOf("=");
		if (equals < 1) continue;
		const key = withoutExport.slice(0, equals).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = withoutExport.slice(equals + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	return values;
}

/** True when the file exists and others can read it. The token lives here. */
export function isWorldReadable(path = settingsPath()): boolean {
	try {
		return (statSync(path).mode & 0o077) !== 0;
	} catch {
		return false;
	}
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function portNumber(value: unknown): number | undefined {
	// Number("") is 0, so an absent value must be rejected before the cast.
	if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
	const word = text(value);
	if (word === undefined || !/^\d+$/.test(word)) return undefined;
	const port = Number(word);
	return port >= 0 && port <= 65535 ? port : undefined;
}

/**
 * One value from the environment, then the file, then nothing. An empty
 * environment value counts as unset, so a shell can fall back to the file.
 */
export function resolveSettings(env: NodeJS.ProcessEnv = process.env, file: Record<string, string> = readEnvFile()): BrokerSettings {
	const pick = (name: string): string | undefined => text(env[name]) ?? text(file[name]);

	return {
		token: pick("LEARN_BROKER_TOKEN") ?? null,
		host: pick("LEARN_BROKER_HOST") ?? DEFAULT_HOST,
		port: portNumber(env.LEARN_BROKER_PORT) ?? portNumber(file.LEARN_BROKER_PORT) ?? DEFAULT_PORT,
		logDir: pick("LEARN_BROKER_LOG_DIR"),
		provider: pick("LEARN_BROKER_PROVIDER"),
		serviceUrl: pick("LEARN_SERVICE_URL"),
		serviceToken: pick("LEARN_SERVICE_TOKEN"),
	};
}
