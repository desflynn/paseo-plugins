/**
 * The Learn page's server half. Two fetchers, both token-safe by
 * construction: the Bearer token travels to the service and appears nowhere
 * in any result. Settings come from the same reader the broker core uses
 * (server/config.ts: environment first, then ~/.learnharness/learn-broker.env),
 * so the client never holds the token and never learns it.
 *
 * fetchLearnOverview reads the service's six v1 routes in parallel
 * (Promise.allSettled): one route failing never blanks the page — it fails
 * alone, with its status and the service's own error text. Every route
 * declares the plugin's contract version (X-Learn-Contract: 1); a mismatch
 * comes back 409 and surfaces honestly on the page.
 *
 * startLearnConversation POSTs the mint route with no body: the service
 * derives the session server-side (proven on the real service). The creation
 * turn can take minutes, so the mint's default wait is five minutes, not ten
 * seconds — the client shows a minting state until this resolves.
 */
import type { LearnOverviewResult, LearnRouteResult, LearnStartConversationResult } from "../shared/rpc.ts";
import { resolveSettings, type BrokerSettings } from "./config.ts";

/** The v1 routes the page reads, in page order. */
export const LEARN_ROUTES = [
	{ name: "version", path: "version" },
	{ name: "graph", path: "graph" },
	{ name: "growth", path: "graph/growth" },
	{ name: "sessions", path: "sessions" },
	{ name: "spend", path: "spend" },
	{ name: "tutor", path: "tutor" },
] as const;

export type LearnRouteName = (typeof LEARN_ROUTES)[number]["name"];

export const LEARN_CONTRACT_HEADER = "X-Learn-Contract";
export const LEARN_CONTRACT_VERSION = "1";
/** A plain read: the page wants fresh data, not a four-minute stall. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
/** The mint's creation turn can take minutes to settle; five minutes of
 *  patience is the honest ceiling, and the session view handles the wait
 *  after handoff. */
export const DEFAULT_MINT_TIMEOUT_MS = 300_000;

export interface LearnFetchOptions {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

const NO_SERVICE_URL = "no service URL configured — set LEARN_SERVICE_URL in ~/.learnharness/learn-broker.env";

function serviceBase(settings: BrokerSettings): string | null {
	const url = settings.serviceUrl?.trim();
	if (!url) return null;
	// LEARN_SERVICE_URL is the MCP mount (…/mcp) in a paired deployment — the
	// v1 REST API and the web UI (session view, conversations) live at the
	// origin, so the mount is stripped here. The broker bridge keeps using the
	// raw value, where /mcp is exactly what it wants.
	return url.replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
}

function authHeaders(settings: BrokerSettings): Record<string, string> {
	return {
		[LEARN_CONTRACT_HEADER]: LEARN_CONTRACT_VERSION,
		...(settings.serviceToken ? { Authorization: `Bearer ${settings.serviceToken}` } : {}),
	};
}

function fetchError(err: unknown, timeoutMs: number): string {
	if (err instanceof Error && err.name === "TimeoutError") return `timed out after ${timeoutMs}ms`;
	if (err instanceof Error && err.name === "AbortError") return "aborted before the service answered";
	return `could not reach the service: ${err instanceof Error ? err.message : String(err)}`;
}

/** The service's own words, kept short; never longer than a card can show. */
function briefBody(text: string, status: number): string {
	const trimmed = text.trim().replace(/\s+/g, " ").slice(0, 300);
	return trimmed !== "" ? trimmed : `HTTP ${status}`;
}

async function loadRoute(
	serviceUrl: string,
	path: string,
	headers: Record<string, string>,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<LearnRouteResult> {
	const res = await fetchImpl(`${serviceUrl}/api/v1/${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
	const text = await res.text();
	if (!res.ok) return { ok: false, error: briefBody(text, res.status), status: res.status };
	try {
		return { ok: true, data: JSON.parse(text) as unknown };
	} catch {
		return { ok: false, error: `invalid JSON from ${path}`, status: res.status };
	}
}

export async function fetchLearnOverview(settings: BrokerSettings, options: LearnFetchOptions = {}): Promise<LearnOverviewResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const serviceUrl = serviceBase(settings);
	const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
	const routes: Record<string, LearnRouteResult> = {};
	if (!serviceUrl) {
		for (const { name } of LEARN_ROUTES) routes[name] = { ok: false, error: NO_SERVICE_URL };
		return { serviceUrl: null, fetchedAt, routes } as unknown as LearnOverviewResult;
	}
	const headers = authHeaders(settings);
	const settled = await Promise.allSettled(LEARN_ROUTES.map(({ path }) => loadRoute(serviceUrl, path, headers, fetchImpl, timeoutMs)));
	LEARN_ROUTES.forEach(({ name }, index) => {
		const outcome = settled[index]!;
		routes[name] = outcome.status === "fulfilled" ? outcome.value : { ok: false, error: fetchError(outcome.reason, timeoutMs) };
	});
	return { serviceUrl, fetchedAt, routes } as unknown as LearnOverviewResult;
}

export async function startLearnConversation(
	settings: BrokerSettings,
	options: LearnFetchOptions = {},
): Promise<LearnStartConversationResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_MINT_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const serviceUrl = serviceBase(settings);
	if (!serviceUrl) return { ok: false, error: NO_SERVICE_URL };
	try {
		const res = await fetchImpl(`${serviceUrl}/api/conversations`, { method: "POST", headers: authHeaders(settings), signal: AbortSignal.timeout(timeoutMs) });
		const text = await res.text();
		if (!res.ok) return { ok: false, error: briefBody(text, res.status), status: res.status };
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { ok: false, error: `unexpected mint reply (invalid JSON: ${briefBody(text, res.status)})`, status: res.status };
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, error: "unexpected mint reply (not an object)", status: res.status };
		}
		const record = parsed as Record<string, unknown>;
		const conversationId = typeof record.conversationId === "string" && record.conversationId !== "" ? record.conversationId : undefined;
		if (!conversationId) return { ok: false, error: `unexpected mint reply (no conversationId)`, status: res.status };
		const childId = typeof record.childId === "string" ? record.childId : null;
		return { ok: true, conversationId, childId };
	} catch (err) {
		return { ok: false, error: fetchError(err, timeoutMs) };
	}
}

// The RPC handlers the daemon wires in index.server.ts. Parameterless on
// purpose: the settings are read per call, so a changed env file is picked up
// without a reload.
export async function handleLearnOverview(): Promise<LearnOverviewResult> {
	return fetchLearnOverview(resolveSettings());
}

export async function handleLearnConversation(): Promise<LearnStartConversationResult> {
	return startLearnConversation(resolveSettings());
}
