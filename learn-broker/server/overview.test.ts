// The Learn page's server half: one envelope RPC that reads the service's six
// v1 routes (version, graph, growth, sessions, spend, tutor), and the mint RPC
// that starts a new conversation. These tests pin the promises the page makes:
// one route failing never blanks the page, a 409 surfaces honestly, a slow
// route times out without sinking the rest, the Bearer token travels but never
// returns, and the mint POST carries no workspaceId — the service derives the
// session server-side (proven on the real service).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fetchLearnOverview, startLearnConversation } from "./overview.ts";
import type { BrokerSettings } from "./config.ts";

type SeenRequest = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

type Double = { base: string; requests: SeenRequest[]; close(): Promise<void> };

/** A scripted learn-service double. The handler owns the response; every
 *  request is captured so tests can read what actually travelled. */
async function startDouble(handler: (req: IncomingMessage, res: ServerResponse, body: string, requests: SeenRequest[]) => void): Promise<Double> {
	const requests: SeenRequest[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const seen: SeenRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
			requests.push(seen);
			handler(req, res, seen.body, requests);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
	const text = JSON.stringify(payload);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) });
	res.end(text);
}

/** The full six-route service, all healthy. */
function healthyService(req: IncomingMessage, res: ServerResponse): void {
	const payloads: Record<string, unknown> = {
		"/api/v1/version": { serviceVersion: "0.3.5", contractVersion: 1, minimumPluginContractVersion: 1 },
		"/api/v1/graph": { totals: { nodes: 12, edges: 30 } },
		"/api/v1/graph/growth": { recent: 4 },
		"/api/v1/sessions": { sessions: [{ id: "s1", status: "concluded", childAgentId: "a1" }] },
		"/api/v1/spend": { totalTokens: 1234, currency: "EUR", total: 5.5 },
		"/api/v1/tutor": { id: "tutor-9", status: "idle" },
	};
	const payload = payloads[req.url ?? ""];
	if (payload === undefined) {
		json(res, 404, { error: `no such route: ${req.url}` });
		return;
	}
	json(res, 200, payload);
}

const SERVICE_TOKEN = "service-token-value";

function settings(base?: string): BrokerSettings {
	return { token: "broker-pairing-token", host: "127.0.0.1", port: 0, serviceUrl: base, serviceToken: SERVICE_TOKEN };
}

test("overview: one envelope, six routes, all ok, auth and contract header travelled", async () => {
	const double = await startDouble(healthyService);
	try {
		const result = await fetchLearnOverview(settings(double.base));
		assert.deepEqual(Object.keys(result.routes).sort(), ["graph", "growth", "sessions", "spend", "tutor", "version"]);
		for (const name of Object.keys(result.routes)) {
			assert.equal(result.routes[name as keyof typeof result.routes].ok, true, `${name} should be ok`);
		}
		assert.deepEqual(result.routes.graph.data, { totals: { nodes: 12, edges: 30 } });
		assert.deepEqual(result.routes.growth.data, { recent: 4 });
		assert.equal(result.serviceUrl, double.base);
		assert.equal(Number.isNaN(Date.parse(result.fetchedAt)), false, "fetchedAt must be an ISO date");
		assert.equal(double.requests.length, 6);
		for (const seen of double.requests) {
			assert.equal(seen.headers.authorization, `Bearer ${SERVICE_TOKEN}`);
			assert.equal(seen.headers["x-learn-contract"], "1");
		}
	} finally {
		await double.close();
	}
});

test("overview: a failing route never blanks the page; a 409 surfaces honestly", async () => {
	const double = await startDouble((req, res) => {
		if (req.url === "/api/v1/graph") {
			json(res, 500, { error: "graph store unavailable" });
			return;
		}
		if (req.url === "/api/v1/version") {
			json(res, 409, { error: "contract mismatch: this service speaks contract 2" });
			return;
		}
		healthyService(req, res);
	});
	try {
		const result = await fetchLearnOverview(settings(double.base));
		assert.equal(result.routes.graph.ok, false);
		assert.equal(result.routes.graph.status, 500);
		assert.match(result.routes.graph.error, /graph store unavailable/);
		assert.equal(result.routes.version.ok, false);
		assert.equal(result.routes.version.status, 409);
		assert.match(result.routes.version.error, /contract 2/);
		for (const name of ["growth", "sessions", "spend", "tutor"] as const) {
			assert.equal(result.routes[name].ok, true, `${name} must survive a sibling failure`);
		}
	} finally {
		await double.close();
	}
});

test("overview: a slow route times out without sinking the rest", async () => {
	const double = await startDouble((req, res) => {
		if (req.url === "/api/v1/spend") return; // never answers
		healthyService(req, res);
	});
	try {
		const result = await fetchLearnOverview(settings(double.base), { timeoutMs: 80 });
		assert.equal(result.routes.spend.ok, false);
		assert.match(result.routes.spend.error, /timed out after 80ms/);
		assert.equal(result.routes.version.ok, true);
		assert.equal(result.routes.tutor.ok, true);
	} finally {
		await double.close();
	}
});

test("overview: no service URL configured is honest, not a throw", async () => {
	const result = await fetchLearnOverview(settings(undefined));
	assert.equal(result.serviceUrl, null);
	for (const name of Object.keys(result.routes)) {
		const route = result.routes[name as keyof typeof result.routes];
		assert.equal(route.ok, false);
		if (!route.ok) assert.match(route.error, /no service URL/i);
	}
});

test("overview: an unreachable service errors every route, fast", async () => {
	const result = await fetchLearnOverview(settings("http://127.0.0.1:9"), { timeoutMs: 2_000 });
	for (const name of Object.keys(result.routes)) {
		assert.equal(result.routes[name as keyof typeof result.routes].ok, false, `${name} should fail`);
	}
});

test("overview: the envelope never carries the token", async () => {
	const double = await startDouble(healthyService);
	try {
		const result = await fetchLearnOverview(settings(double.base));
		const envelope = JSON.stringify(result);
		assert.doesNotMatch(envelope, /service-token-value/);
		assert.doesNotMatch(envelope, /broker-pairing-token/);
	} finally {
		await double.close();
	}
});

test("overview: an MCP-mount service URL reads the API at the origin", async () => {
	const double = await startDouble(healthyService);
	try {
		const result = await fetchLearnOverview({ ...settings(`${double.base}/mcp`) });
		assert.equal(result.serviceUrl, double.base, "the envelope carries the origin, so web links work");
		for (const name of Object.keys(result.routes)) {
			assert.equal(result.routes[name as keyof typeof result.routes].ok, true, `${name} via the origin`);
		}
	} finally {
		await double.close();
	}
});

test("mint: POSTs /api/conversations with no body and hands back the ids", async () => {
	const double = await startDouble((req, res) => {
		if (req.method === "POST" && req.url === "/api/conversations") {
			json(res, 201, { conversationId: "conv-41", childId: "child-7" });
			return;
		}
		json(res, 404, { error: "unexpected route" });
	});
	try {
		const result = await startLearnConversation(settings(double.base));
		assert.deepEqual(result, { ok: true, conversationId: "conv-41", childId: "child-7" });
		assert.equal(double.requests.length, 1);
		const seen = double.requests[0]!;
		assert.equal(seen.method, "POST");
		assert.equal(seen.url, "/api/conversations");
		assert.equal(seen.body, "", "the mint carries no workspaceId — the service derives the session");
		assert.equal(seen.headers.authorization, `Bearer ${SERVICE_TOKEN}`);
	} finally {
		await double.close();
	}
});

test("mint: a refusal is honest, with status and body", async () => {
	const double = await startDouble((_req, res) => json(res, 403, { error: "the daemon is not paired" }));
	try {
		const result = await startLearnConversation(settings(double.base));
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 403);
			assert.match(result.error, /not paired/);
		}
	} finally {
		await double.close();
	}
});

test("mint: the creation turn is slow by design, so the wait is long and the timeout longer", async () => {
	const double = await startDouble((req, res) => {
		if (req.url === "/api/conversations") return; // never answers
		json(res, 404, { error: "unexpected route" });
	});
	try {
		const result = await startLearnConversation(settings(double.base), { timeoutMs: 80 });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /timed out after 80ms/);
	} finally {
		await double.close();
	}
});

test("mint: no service URL and a bad payload are both honest", async () => {
	const noUrl = await startLearnConversation(settings(undefined));
	assert.equal(noUrl.ok, false);
	if (!noUrl.ok) assert.match(noUrl.error, /no service URL/i);

	const double = await startDouble((_req, res) => json(res, 201, { what: "no ids here" }));
	try {
		const bad = await startLearnConversation(settings(double.base));
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.match(bad.error, /unexpected/);
		assert.equal(bad.status, 201);
	} finally {
		await double.close();
	}
});
