/**
 * Adapter placement pin (the live-smoke bug, 28 Oct): the SDK delivers
 * placement to the HANDLE — refresh() returns nothing; workspaceId reads
 * as a handle property (public-docs/sdk/reference.md:103; the canonical
 * handle read at agents.md:90-96). The pre-fix adapter read placement off
 * refresh()'s return and could never place a conversation child
 * ("tutor <id> has no workspace placement", 1ms, deterministic, live on
 * the ideaPad). archiveAgent's unknown-agent detection had the same
 * shape bug. This test pins the corrected shape in-branch (the
 * config.test.ts precedent: the branch is the durable home).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { UnknownAgentError } from "./broker-core.ts";
import {
	createPaseoBrokerAdapter,
	type PaseoSdkApi,
} from "./paseo-adapter.ts";

/** A docs-shaped handle: refresh() delivers the snapshot onto the handle. */
const handle = (id: string, workspaceId?: string) => ({
	id,
	workspaceId,
	async refresh() {},
	async archive() {},
	timeline: { async refetch() { return { entries: [] }; } },
});

function makeSdk(): PaseoSdkApi {
	return {
		agents: {
			ref: (id: string) =>
				id === "ghost"
					? { ...handle(id), async refresh() { throw new Error("unknown agent"); } }
					: handle(id, id === "tutor_1" ? "ws_docs" : undefined),
		},
		workspaces: {
			ref: (ws: string) => ({
				agents: {
					async create() {
						return { id: `child_of_${ws}` };
					},
				},
			}),
		},
	} as unknown as PaseoSdkApi;
}

test("child placement reads the HANDLE after refresh (docs shape)", async () => {
	const adapter = createPaseoBrokerAdapter(makeSdk(), {
		resolveBridge: () => ({ mcpServers: { learn: { type: "http", url: "http://x/mcp" } } }),
	});
	const child = await adapter.createConversationChild({
		tutorId: "tutor_1",
		conversationId: "conv-1",
		personaPreps: [],
		tools: [],
		autoArchive: true,
	});
	assert.equal(child.childId, "child_of_ws_docs");
	assert.ok(child.bridge.mcpServers.learn);
});

test("archiveAgent: unknown agent refresh throws → false; known agent archives", async () => {
	const adapter = createPaseoBrokerAdapter(makeSdk(), {
		resolveBridge: () => ({ mcpServers: { learn: { type: "http", url: "http://x/mcp" } } }),
	});
	assert.equal(await adapter.archiveAgent("ghost"), false);
	assert.equal(await adapter.archiveAgent("tutor_1"), true);
});

test("utility creation derives provider (request harness-first > env > honest refusal) and passes a cwd", async () => {
	const created: Array<Record<string, unknown>> = [];
	const handle = (id: string) => ({ id, workspaceId: "ws_docs", async refresh() {}, async archive() {},
		timeline: { async refetch() { return { entries: [] }; } } });
	const make = (envProvider?: string) => {
		created.length = 0;
		const sdk: PaseoSdkApi = {
			agents: {
				async create(opts: any) { created.push(opts); return handle(`u_${created.length}`); },
				async list() { return { entries: [] }; },
				ref: (id: string) => handle(id),
			},
			workspaces: { ref: () => ({ agents: { async create(opts: any) { created.push(opts); return { id: "c" }; } } }) },
		} as unknown as PaseoSdkApi;
		return createPaseoBrokerAdapter(sdk, { provider: envProvider, resolveBridge: () => ({ mcpServers: { learn: { type: "http", url: "http://x/mcp" } } }) });
	};
	const req = (provider: string, id: string) => ({ callId: "x", purpose: "p", model: { provider, id }, messages: [{ role: "user", content: "hi" }] as never });

	// harness-first request model wins: pi/zai/glm-5.3-flash (two slashes combined)
	const a = make("env-pin/zai/glm-5.3-flash");
	// runCompletionTurn needs run() on the handle — extend the double minimal: reuse smoke shapes
	// (runCompletionTurn path covered by the reuse test; here we pin creation opts via a throw on run)
	await a.runCompletionTurn("c1", req("pi", "zai/glm-5.3-flash") as never).catch(() => {});
	assert.ok(created.length >= 1, "utility created");
	assert.equal(created[0]!.config!.provider, "pi/zai/glm-5.3-flash", "harness-first request model wins over env");
	assert.ok(typeof created[0]!.cwd === "string" && (created[0]!.cwd as string).length > 0, "cwd passed");

	// env fallback when request model is not harness-first (id has no slash)
	const b = make("env-pin/zai/glm-5.3-flash");
	await b.runCompletionTurn("c2", req("smoke", "smoke-complete") as never).catch(() => {});
	assert.equal(created[0]!.config!.provider, "env-pin/zai/glm-5.3-flash", "env pin used when request model is not harness-first");

	// honest refusal when neither is usable
	const c = make(undefined as unknown as string);
	await assert.rejects(() => c.runCompletionTurn("c3", req("smoke", "smoke-complete") as never), /provider|cwd/i);
});

test("sendToAgent: an agent in the broker's own records (label namespace) receives the send", async () => {
	const sent: string[] = [];
	const childHandle = {
		id: "child_1",
		async send(text: string) {
			sent.push(text);
		},
		async refresh() {},
		async archive() {},
		timeline: { async refetch() { return { entries: [] }; } },
	};
	const sdk = {
		agents: {
			ref: () => childHandle,
			async list() {
				return {
					entries: [
						{ agent: { id: "tutor_9", labels: { "learn-tutor": "ws_1" } } },
						{ agent: { id: "child_1", labels: { "learn-conversation": "conv_42" } } },
					],
				};
			},
		},
		workspaces: {
			ref: () => ({ agents: { async create() { return { id: "x" }; } } }),
		},
	} as unknown as PaseoSdkApi;
	const adapter = createPaseoBrokerAdapter(sdk, {
		resolveBridge: () => ({ mcpServers: { learn: { type: "http", url: "http://x/mcp" } } }),
	});
	await adapter.sendToAgent("child_1", "hello child");
	assert.deepEqual(sent, ["hello child"]);
});

test("sendToAgent: an id the broker did not create is refused and the daemon NEVER receives a send", async () => {
	const sent: string[] = [];
	const daemonHandle = (id: string) => ({
		id,
		async send(text: string) {
			sent.push(text);
		},
		async refresh() {},
		async archive() {},
		timeline: { async refetch() { return { entries: [] }; } },
	});
	// stranger EXISTS in the daemon (a foreign agent) — scoping must not
	// care: only broker-created records may receive a send.
	const sdk = {
		agents: {
			ref: (id: string) => daemonHandle(id),
			async list() {
				return {
					entries: [
						{ agent: { id: "stranger", labels: { "unrelated-label": "x" } } },
						// fail-closed shape: an entry with NO labels at all
						{ agent: { id: "mystery" } },
					],
				};
			},
		},
		workspaces: {
			ref: () => ({ agents: { async create() { return { id: "x" }; } } }),
		},
	} as unknown as PaseoSdkApi;
	const adapter = createPaseoBrokerAdapter(sdk, {
		resolveBridge: () => ({ mcpServers: { learn: { type: "http", url: "http://x/mcp" } } }),
	});
	await assert.rejects(
		() => adapter.sendToAgent("stranger", "should never land"),
		(err: unknown) =>
			err instanceof UnknownAgentError &&
			/not in the broker's own records/.test((err as Error).message),
	);
	await assert.rejects(() => adapter.sendToAgent("ghost", "x"), UnknownAgentError);
	await assert.rejects(
		() => adapter.sendToAgent("mystery", "x"),
		UnknownAgentError,
		"an entry with no labels fails closed",
	);
	assert.deepEqual(sent, [], "the daemon double received NO send — the scoping law");
});

test("complete() usage: refresh() after the turn delivers the usage snapshot (audit-falsity fix)", async () => {
	const created: unknown[] = [];
	const handle = {
		id: "u_1", workspaceId: "ws_docs",
		// The audit-falsity shape: run() delivers the turn result but the
		// usage snapshot arrives on the HANDLE only after refresh().
		lastUsage: null as null | { inputTokens: number; outputTokens: number },
		async refresh() {
			this.lastUsage = { inputTokens: 11, outputTokens: 7 };
		},
		async run() {
			return { status: "idle" as const, lastMessage: "ack" };
		},
		async send() {},
		async waitForFinish() { return { status: "idle" as const, lastMessage: "ack" }; },
		async archive() {},
		timeline: { async refetch() { return { entries: [] }; } },
	};
	const sdk: PaseoSdkApi = {
		agents: {
			async create(opts: any) { created.push(opts); return handle; },
			async list() { return { entries: [] }; },
			ref: (id: string) => handle as never,
		},
		workspaces: { ref: () => ({ agents: { async create(opts: any) { created.push(opts); return handle; } } }) },
	} as unknown as PaseoSdkApi;
	const adapter = createPaseoBrokerAdapter(sdk, {
		provider: "env-pin/zai/glm-5.3-flash",
		resolveBridge: () => ({ mcpServers: { learn: { type: "http", url: "http://x/mcp" } } }),
	});
	const r = await adapter.runCompletionTurn("u1", {
		callId: "u1", purpose: "p", model: { provider: "pi", id: "zai/glm-5.3-flash" },
		messages: [{ role: "user", content: "hi" }],
	} as never);
	assert.equal(r.text, "ack");
	assert.equal(r.usage.input, 11, "input tokens must be the REAL turn's, not zeros (audit-falsity seam)");
	assert.equal(r.usage.output, 7);
	assert.equal(r.usage.totalTokens, 18);
});
