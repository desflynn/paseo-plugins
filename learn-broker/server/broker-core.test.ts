/**
 * learn-broker broker-core tests (learn-on-paseo P5, wave 3).
 *
 * RED-first suite for the v1 broker protocol listener
 * (docs/p5/broker-contract-design.md Part B + gate ruling 2). Runs an
 * in-process listener on an ephemeral port against a scripted
 * BrokerAgentPort double — no Paseo, no daemon, no network beyond
 * localhost.
 *
 * Run: NODE_ENV=test npx tsx --test junk/learn-broker-plugin/tests/broker-core.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, type AddressInfo } from "node:net";
import {
	startBrokerCore,
	UnknownAgentError,
	type BrokerAgentPort,
	type BrokerCompleteRequest,
	type BrokerLogEntry,
	type BrokerUsage,
} from "./broker-core.ts";
import {
	createPaseoBrokerAdapter,
	UTILITY_AGENT_ID,
	type PaseoSdkApi,
} from "./paseo-adapter.ts";

const TOKEN = "test-broker-token";

function authed(extra: Record<string, string> = {}): Record<string, string> {
	return { authorization: `Bearer ${TOKEN}`, ...extra };
}

/** A scripted BrokerAgentPort double: records every call, defers
 *  completions until the test resolves them. */
function scriptedPort() {
	const calls: Array<{ method: string; payload: unknown }> = [];
	const cancels: string[] = [];
	const sentTo: string[] = [];
	const pending = new Map<
		string,
		{
			resolve: (r: { text: string; usage: BrokerUsage }) => void;
			reject: (e: Error) => void;
		}
	>();
	const tutorsEnsured: Array<string | undefined> = [];

	const port: BrokerAgentPort = {
		async ensureTutor(workspaceId) {
			calls.push({ method: "ensureTutor", payload: workspaceId });
			tutorsEnsured.push(workspaceId);
			// The derived-id return: the double echoes a given id and derives
			// a stable one for an omission, mirroring the real adapter.
			return {
				tutorId: "tutor_1",
				created: tutorsEnsured.length === 1,
				workspaceId: workspaceId ?? "ws_derived",
			};
		},
		async createConversationChild(input) {
			calls.push({ method: "createConversationChild", payload: input });
			return {
				childId: "child_1",
				bridge: {
					mcpServers: {
						learn: { type: "http", url: "https://learn.example/mcp" },
					},
				},
			};
		},
		async archiveAgent(agentId) {
			calls.push({ method: "archiveAgent", payload: agentId });
			return agentId === "known_agent";
		},
		async readTimeline(agentId, opts) {
			calls.push({ method: "readTimeline", payload: { agentId, opts } });
			return [{ type: "user_message", text: "hello" }];
		},
		async runCompletionTurn(callId, request) {
			calls.push({ method: "runCompletionTurn", payload: { callId, request } });
			return new Promise((resolve, reject) => {
				pending.set(callId, { resolve, reject });
			});
		},
		async cancelCompletionTurn(callId) {
			cancels.push(callId);
			const p = pending.get(callId);
			if (!p) return false;
			pending.delete(callId);
			p.reject(new Error("turn cancelled"));
			return true;
		},
		async sendToAgent(agentId, text) {
			// The real adapter scopes BEFORE any daemon contact: an id outside
			// the broker's own records throws UnknownAgentError here and
			// nothing is recorded — mirroring "never forwarded". Only a send
			// that actually goes through lands in calls/sentTo.
			if (agentId !== "child_1") {
				throw new UnknownAgentError(
					`agent ${agentId} is not in the broker's own records — refused, not forwarded`,
				);
			}
			calls.push({ method: "sendToAgent", payload: { agentId, text } });
			sentTo.push(agentId);
		},
	};

	return {
		port,
		calls,
		cancels,
		sentTo,
		settle(
			callId: string,
			text = "the answer",
			usage: BrokerUsage = { input: 10, output: 5, totalTokens: 15 },
		) {
			const p = pending.get(callId);
			assert.ok(p, `no pending turn for ${callId}`);
			pending.delete(callId);
			p.resolve({ text, usage });
		},
	};
}

type CoreHandle = Awaited<ReturnType<typeof startBrokerCore>>;

async function startCore(
	port: BrokerAgentPort,
	logDir?: string,
	token: string | null = TOKEN,
): Promise<CoreHandle> {
	return startBrokerCore({ token, logDir, port });
}

async function closeCore(core: CoreHandle): Promise<void> {
	await core.close();
}

function base(core: CoreHandle): string {
	const addr = core.address();
	assert.ok(addr, "listener has no address");
	return `http://127.0.0.1:${addr.port}`;
}

async function json(
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: unknown,
): Promise<{ status: number; envelope: any }> {
	const res = await fetch(url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, envelope: (await res.json()) as any };
}

/** Poll until cond() holds — for waiting on the double's recorded calls. */
async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

const CHILD_BODY = {
	tutorId: "tutor_1",
	conversationId: "conv_42",
	personaPreps: ["be brief"],
	tools: ["learn_search"],
	autoArchive: true,
};

function completeBody(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		callId: "call_1",
		purpose: "compaction summary",
		model: { provider: "zai", id: "glm-5.3-flash" },
		systemPrompt: "You summarize.",
		messages: [{ role: "user", content: "Summarize this transcript." }],
		timeoutMs: 5_000,
		...over,
	};
}

test("no token configured: the broker refuses to start (fail-closed)", async () => {
	const d = scriptedPort();
	await assert.rejects(
		() => startCore(d.port, undefined, null),
		/fail-closed|token/i,
	);
	await assert.rejects(() => startCore(d.port, undefined, ""));
});

test("401 wall: every route refuses without or with a wrong token, nothing logged", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const routes: Array<[string, string]> = [
			["POST", "/v1/agents/ensure-tutor"],
			["POST", "/v1/agents/child"],
			["POST", "/v1/agents/known_agent/archive"],
			["POST", "/v1/agents/known_agent/send"],
			["GET", "/v1/agents/known_agent/timeline"],
			["POST", "/v1/complete"],
			["DELETE", "/v1/complete/call_1"],
			["GET", "/v1/log"],
		];
		for (const [method, path] of routes) {
			const noToken = await json(root + path, method, {});
			assert.equal(noToken.status, 401, `${method} ${path} without token`);
			assert.equal(noToken.envelope.ok, false);
			assert.equal(noToken.envelope.error.kind, "unauthorized");
			assert.equal(noToken.envelope.log, null);
			const wrong = await json(root + path, method, {
				authorization: "Bearer wrong",
			});
			assert.equal(wrong.status, 401, `${method} ${path} wrong token`);
			assert.equal(wrong.envelope.error.kind, "unauthorized");
		}
		// Refused calls are not ops: the log stays empty.
		assert.equal(core.readLog().length, 0);
	} finally {
		await closeCore(core);
	}
});

test("each op answers its envelope with its own log entry; GET /v1/log reads them all", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const h = authed();

		const ensure = await json(root + "/v1/agents/ensure-tutor", "POST", h, {
			workspaceId: "ws_1",
		});
		assert.equal(ensure.status, 200);
		assert.equal(ensure.envelope.ok, true);
		assert.deepEqual(ensure.envelope.data, {
			tutorId: "tutor_1",
			created: true,
			workspaceId: "ws_1",
		});
		assert.equal(ensure.envelope.log.op, "ensure-tutor");
		assert.equal(ensure.envelope.log.seq, 1);
		assert.equal(ensure.envelope.log.callId, "ws_1");

		const child = await json(root + "/v1/agents/child", "POST", h, CHILD_BODY);
		assert.equal(child.envelope.ok, true);
		assert.equal(child.envelope.data.childId, "child_1");
		assert.ok(child.envelope.data.bridge.mcpServers.learn);
		assert.equal(child.envelope.log.op, "child");
		assert.equal(child.envelope.log.seq, 2);
		assert.equal(child.envelope.log.callId, "conv_42");

		const archive = await json(
			root + "/v1/agents/known_agent/archive",
			"POST",
			h,
			{},
		);
		assert.equal(archive.envelope.ok, true);
		assert.deepEqual(archive.envelope.data, { archived: true });
		assert.equal(archive.envelope.log.op, "archive");
		assert.equal(archive.envelope.log.seq, 3);
		assert.equal(archive.envelope.log.callId, "known_agent");

		const archiveUnknown = await json(
			root + "/v1/agents/ghost/archive",
			"POST",
			h,
			{},
		);
		assert.equal(archiveUnknown.envelope.ok, true);
		assert.deepEqual(archiveUnknown.envelope.data, { archived: false });

		const timeline = await json(
			root + "/v1/agents/child_1/timeline?includeArchived=true",
			"GET",
			h,
		);
		assert.equal(timeline.envelope.ok, true);
		assert.equal(timeline.envelope.data.entries.length, 1);
		assert.equal(timeline.envelope.log.op, "timeline");
		assert.equal(timeline.envelope.log.callId, "child_1");
		const tl = d.calls.find((c) => c.method === "readTimeline");
		assert.ok(tl);
		assert.deepEqual(
			(tl.payload as any).opts,
			{ includeArchived: true },
			"includeArchived passes through to the port",
		);

		const pendingComplete = json(root + "/v1/complete", "POST", h, completeBody());
		await waitFor(() => d.calls.some((c) => c.method === "runCompletionTurn"));
		d.settle("call_1");
		const complete = await pendingComplete;
		assert.equal(complete.status, 200);
		assert.equal(complete.envelope.ok, true, JSON.stringify(complete.envelope));
		assert.equal(complete.envelope.data.text, "the answer");
		assert.deepEqual(complete.envelope.data.usage, {
			input: 10,
			output: 5,
			totalTokens: 15,
		});
		assert.equal(complete.envelope.log.op, "complete");
		assert.equal(complete.envelope.log.callId, "call_1");
		assert.equal(complete.envelope.log.model, "zai:glm-5.3-flash");
		assert.equal(complete.envelope.log.textChars, "the answer".length);
		assert.deepEqual(complete.envelope.log.usage, {
			input: 10,
			output: 5,
			totalTokens: 15,
		});

		const logRead = await json(root + "/v1/log", "GET", h);
		assert.equal(logRead.envelope.ok, true);
		const entries = logRead.envelope.data.entries as BrokerLogEntry[];
		assert.equal(entries.length, 6, "five ops + the failed archive read? no: ensure,child,archive,archive-ghost,timeline,complete");
		assert.deepEqual(
			entries.map((e) => e.op),
			["ensure-tutor", "child", "archive", "archive", "timeline", "complete"],
		);
		assert.deepEqual(
			entries.map((e) => e.seq),
			[1, 2, 3, 4, 5, 6],
			"seq is contiguous from 1",
		);
		// The log read itself appends nothing (no self-referential growth).
		const again = await json(root + "/v1/log", "GET", h);
		assert.equal((again.envelope.data.entries as unknown[]).length, 6);
	} finally {
		await closeCore(core);
	}
});

test("send op: happy path — POST /v1/agents/:id/send forwards {text} and answers the full envelope", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const res = await json(root + "/v1/agents/child_1/send", "POST", authed(), {
			text: "hello child",
		});
		assert.equal(res.status, 200);
		assert.equal(res.envelope.ok, true);
		assert.deepEqual(res.envelope.data, {}, "success data is the empty object");
		assert.equal(res.envelope.log.op, "send");
		assert.equal(res.envelope.log.callId, "child_1");
		assert.equal(res.envelope.log.ok, true);
		const send = d.calls.find((c) => c.method === "sendToAgent");
		assert.ok(send, "the port received the send");
		assert.deepEqual(send!.payload, { agentId: "child_1", text: "hello child" });
	} finally {
		await closeCore(core);
	}
});

test("send op: an id outside the broker's records is refused unknown_agent, still logged, never sent", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const res = await json(root + "/v1/agents/stranger/send", "POST", authed(), {
			text: "should never land",
		});
		assert.equal(res.status, 200);
		assert.equal(res.envelope.ok, false);
		assert.equal(res.envelope.error.kind, "unknown_agent");
		// Law 2: the refusal is still a logged op with its full envelope.
		assert.equal(res.envelope.log.op, "send");
		assert.equal(res.envelope.log.ok, false);
		assert.match(res.envelope.log.error ?? "", /records/);
		// Law 1: the daemon-side send never executed.
		assert.deepEqual(d.sentTo, [], "no agent was actually sent to");
	} finally {
		await closeCore(core);
	}
});

test("send op: a daemon failure is an honest envelope error, never a silent ok", async () => {
	const d = scriptedPort();
	const orig = d.port.sendToAgent;
	d.port.sendToAgent = async (agentId, text) => {
		if (agentId === "child_1") {
			throw new Error("daemon send failed: socket exploded");
		}
		return orig(agentId, text);
	};
	const core = await startCore(d.port);
	try {
		const res = await json(base(core) + "/v1/agents/child_1/send", "POST", authed(), { text: "hi" });
		assert.equal(res.status, 200);
		assert.equal(res.envelope.ok, false);
		assert.equal(res.envelope.error.kind, "agent_error");
		assert.match(res.envelope.error.message, /socket exploded/);
		assert.equal(res.envelope.log.op, "send");
		assert.equal(res.envelope.log.ok, false);
		assert.match(res.envelope.log.error ?? "", /socket exploded/);
	} finally {
		await closeCore(core);
	}
});

test("send op: bad bodies are honest 400s, logged nowhere", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const h = authed();
		for (const body of [undefined, {}, { text: "" }, { text: 7 }]) {
			const res = await json(root + "/v1/agents/child_1/send", "POST", h, body as never);
			assert.equal(res.status, 400, JSON.stringify(body));
			assert.equal(res.envelope.error.kind, "bad_request");
			assert.equal(res.envelope.log, null);
		}
		assert.equal(core.readLog().length, 0, "no op ran, so nothing logged");
	} finally {
		await closeCore(core);
	}
});

test("timeout is enforced broker-side: the port's turn is cancelled and the error is honest", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const pendingComplete = json(
			root + "/v1/complete",
			"POST",
			authed(),
			completeBody({ callId: "slow_call", timeoutMs: 50 }),
		);
		const res = await pendingComplete;
		assert.equal(res.status, 200);
		assert.equal(res.envelope.ok, false);
		assert.equal(res.envelope.error.kind, "timeout");
		assert.match(res.envelope.error.message, /timeout|50/i);
		assert.deepEqual(d.cancels, ["slow_call"], "the double records the cancel");
		assert.equal(res.envelope.log.op, "complete");
		assert.equal(res.envelope.log.ok, false);
		assert.match(res.envelope.log.error ?? "", /timeout/i);
	} finally {
		await closeCore(core);
	}
});

test("DELETE /v1/complete/:callId cancels an in-flight turn; the call answers aborted", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const h = authed();
		const pendingComplete = json(
			root + "/v1/complete",
			"POST",
			h,
			completeBody({ callId: "doomed", timeoutMs: 60_000 }),
		);
		// Let the complete reach the port first.
		await new Promise((r) => setTimeout(r, 30));
		const del = await json(root + "/v1/complete/doomed", "DELETE", h);
		assert.equal(del.status, 200);
		assert.equal(del.envelope.ok, true);
		assert.deepEqual(del.envelope.data, { cancelled: true });
		assert.equal(del.envelope.log.op, "cancel");
		assert.equal(del.envelope.log.callId, "doomed");

		const res = await pendingComplete;
		assert.equal(res.envelope.ok, false);
		assert.equal(res.envelope.error.kind, "aborted");
		assert.deepEqual(d.cancels, ["doomed"], "cancel reaches the port once");
	} finally {
		await closeCore(core);
	}
});

test("DELETE cancel of an unknown call answers cancelled:false and still logs", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const del = await json(
			root + "/v1/complete/never_started",
			"DELETE",
			authed(),
		);
		assert.equal(del.envelope.ok, true);
		assert.deepEqual(del.envelope.data, { cancelled: false });
		assert.equal(del.envelope.log.op, "cancel");
	} finally {
		await closeCore(core);
	}
});

test("complete: two calls pass distinct self-contained payloads; no carry-over", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const h = authed();
		const p1 = json(
			root + "/v1/complete",
			"POST",
			h,
			completeBody({
				callId: "c1",
				systemPrompt: "You summarize.",
				messages: [{ role: "user", content: "TRANSCRIPT ONE" }],
			}),
		);
		const p2 = json(
			root + "/v1/complete",
			"POST",
			h,
			completeBody({
				callId: "c2",
				systemPrompt: "You extract actions.",
				messages: [{ role: "user", content: "TRANSCRIPT TWO" }],
			}),
		);
		await waitFor(
			() => d.calls.filter((c) => c.method === "runCompletionTurn").length === 2,
		);
		d.settle("c1", "answer one");
		d.settle("c2", "answer two");
		const [first, second] = await Promise.all([p1, p2]);
		assert.equal(first.envelope.ok, true);
		assert.equal(second.envelope.ok, true);
		assert.equal(first.envelope.data.text, "answer one");
		assert.equal(second.envelope.data.text, "answer two");

		const runs = d.calls.filter((c) => c.method === "runCompletionTurn");
		assert.equal(runs.length, 2);
		const r1 = (runs[0]!.payload as any).request as BrokerCompleteRequest;
		const r2 = (runs[1]!.payload as any).request as BrokerCompleteRequest;
		assert.equal(r1.callId, "c1");
		assert.equal(r2.callId, "c2");
		assert.equal(r1.messages[0]!.content, "TRANSCRIPT ONE");
		assert.equal(r2.messages[0]!.content, "TRANSCRIPT TWO");
		assert.equal(r2.systemPrompt, "You extract actions.");
		assert.ok(
			!JSON.stringify(r2).includes("TRANSCRIPT ONE"),
			"second call carries no trace of the first",
		);
	} finally {
		await closeCore(core);
	}
});

test("log persists across restart: a new listener on the same dir reads prior entries and continues seq", async () => {
	const dir = mkdtempSync(join(tmpdir(), "broker-log-"));
	try {
		const d1 = scriptedPort();
		const core1 = await startCore(d1.port, dir);
		const root1 = base(core1);
		await json(root1 + "/v1/agents/ensure-tutor", "POST", authed(), {
			workspaceId: "ws_restart",
		});
		await closeCore(core1);

		const d2 = scriptedPort();
		const core2 = await startCore(d2.port, dir);
		try {
			const root2 = base(core2);
			const logRead = await json(root2 + "/v1/log", "GET", authed());
			const entries = logRead.envelope.data.entries as BrokerLogEntry[];
			assert.equal(entries.length, 1, "prior entry is read back");
			assert.equal(entries[0]!.op, "ensure-tutor");
			assert.equal(entries[0]!.callId, "ws_restart");

			await json(root2 + "/v1/agents/ensure-tutor", "POST", authed(), {
				workspaceId: "ws_again",
			});
			const after = await json(root2 + "/v1/log", "GET", authed());
			const all = after.envelope.data.entries as BrokerLogEntry[];
			assert.equal(all.length, 2);
			assert.equal(all[1]!.seq, 2, "seq continues, never restarts at 1");
		} finally {
			await closeCore(core2);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bad requests are honest 400s, logged nowhere", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		const h = authed();
		// child with an extra field breaks the lean five-field law
		const extra = await json(root + "/v1/agents/child", "POST", h, {
			...CHILD_BODY,
			seat: "guy",
		});
		assert.equal(extra.status, 400);
		assert.equal(extra.envelope.error.kind, "bad_request");
		assert.equal(extra.envelope.log, null);

		const malformed = await fetch(root + "/v1/complete", {
			method: "POST",
			headers: h,
			body: "{not json",
		});
		assert.equal(malformed.status, 400);
		const mj = (await malformed.json()) as any;
		assert.equal(mj.error.kind, "bad_request");

		const noTimeout = await json(
			root + "/v1/complete",
			"POST",
			h,
			completeBody({ timeoutMs: undefined }),
		);
		assert.equal(noTimeout.status, 400);

		const unknown = await json(root + "/v1/nope", "GET", h);
		assert.equal(unknown.status, 404);
		assert.equal(unknown.envelope.error.kind, "transport");

		assert.equal(core.readLog().length, 0, "no op ran, so nothing logged");
	} finally {
		await closeCore(core);
	}
});

test("ensure-tutor: an omitted workspaceId is derived — data carries the port's non-empty workspaceId", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		for (const body of [undefined, {}]) {
			const { status, envelope } = await json(
				root + "/v1/agents/ensure-tutor",
				"POST",
				authed(),
				body,
			);
			assert.equal(status, 200, "an omitted workspaceId no longer refuses");
			assert.equal(envelope.ok, true);
			assert.equal(typeof envelope.data.workspaceId, "string");
			assert.ok(
				(envelope.data.workspaceId as string).length > 0,
				"the derived id is a non-empty string",
			);
		}
		// the port saw the omission itself, never a fabricated id
		const ensured = d.calls.filter((c) => c.method === "ensureTutor");
		assert.equal(ensured.length, 2);
		assert.ok(ensured.every((c) => c.payload === undefined), "the port received the omission verbatim");

		// a present-but-empty value is still a bad request, never a derivation
		const empty = await json(root + "/v1/agents/ensure-tutor", "POST", authed(), { workspaceId: "" });
		assert.equal(empty.status, 400);
		assert.equal(empty.envelope.error.kind, "bad_request");
	} finally {
		await closeCore(core);
	}
});

test("the configured port is the one bound (stable port, not ephemeral)", async () => {
	const d = scriptedPort();
	// scout a free port, release it, then hand it to the core
	const free = await new Promise<number>((resolve, reject) => {
		const scout = createServer();
		scout.listen(0, "127.0.0.1", () => {
			const port = (scout.address() as AddressInfo).port;
			scout.close(() => resolve(port));
		});
		scout.on("error", reject);
	});
	const core = await startBrokerCore({ token: TOKEN, port: d.port, listenPort: free });
	try {
		assert.equal(core.address()?.port, free, "the core binds the configured port verbatim");
	} finally {
		await closeCore(core);
	}
});

test("port failures map to honest agent_error entries", async () => {
	const d = scriptedPort();
	const core = await startCore(d.port);
	try {
		const root = base(core);
		// archive on the double throws only for this sentinel id
		const orig = d.port.archiveAgent;
		d.port.archiveAgent = async (id) => {
			if (id === "boom") throw new Error("daemon unreachable");
			return orig(id);
		};
		const res = await json(root + "/v1/agents/boom/archive", "POST", authed(), {});
		assert.equal(res.status, 200);
		assert.equal(res.envelope.ok, false);
		assert.equal(res.envelope.error.kind, "agent_error");
		assert.match(res.envelope.error.message, /daemon unreachable/);
		assert.equal(res.envelope.log.ok, false);
		assert.match(res.envelope.log.error ?? "", /daemon unreachable/);
	} finally {
		await closeCore(core);
	}
});

test("adapter: one REUSED utility agent, fresh self-contained instructions per call", async () => {
	const createdTitles: string[] = [];
	const runCalls: Array<{ handleId: string; text: string }> = [];
	let handleSeq = 0;

	function makeSdk(): PaseoSdkApi {
		const handle = (id: string) => ({
			id,
			async run(text: string) {
				runCalls.push({ handleId: id, text });
				return { status: "idle" as const, lastMessage: "ok" };
			},
			async send(
				_text: string,
				_opts?: { activeTurnBehavior?: "interrupt" | "steer" },
			) {},
			async waitForFinish() {
				return { status: "idle" as const, lastMessage: "ok" };
			},
			async archive() {},
			async refresh() {
				// Documented shape: refresh() delivers the snapshot to the HANDLE;
				// workspaceId reads as a property, never from refresh()'s return.
			},
			workspaceId: "ws_1",
			lastUsage: { inputTokens: 7, outputTokens: 3 },
			timeline: {
				async refetch() {
					return { entries: [{ type: "assistant_message", text: "ok" }] };
				},
			},
		});
		const utility = handle(UTILITY_AGENT_ID);
		return {
			agents: {
				async create(opts: any) {
					createdTitles.push(opts.title);
					return handle(`new_${++handleSeq}`);
				},
				ref(id: string) {
					return id === UTILITY_AGENT_ID ? utility : handle(id);
				},
				async list() {
					return { entries: [] as Array<{ agent: { id: string } }> };
				},
			},
			workspaces: {
				ref(_id: string) {
					return {
						agents: {
							async create(opts: any) {
								createdTitles.push(opts.title);
								return handle(`ws_new_${++handleSeq}`);
							},
						},
					};
				},
			},
		};
	}

	const adapter = createPaseoBrokerAdapter(makeSdk(), {
		provider: "env-pin/zai/glm-5.3-flash",
		resolveBridge: () => ({
			mcpServers: {
				learn: { type: "http", url: "https://learn.example/mcp" },
			},
		}),
	});

	const reqA: BrokerCompleteRequest = {
		callId: "a",
		purpose: "p",
		model: { provider: "zai", id: "m" },
		systemPrompt: "SYSTEM A",
		messages: [{ role: "user", content: "TRANSCRIPT A" }],
	};
	const reqB: BrokerCompleteRequest = {
		callId: "b",
		purpose: "p",
		model: { provider: "zai", id: "m" },
		systemPrompt: "SYSTEM B",
		messages: [{ role: "user", content: "TRANSCRIPT B" }],
	};

	const ra = await adapter.runCompletionTurn(reqA.callId, reqA);
	assert.deepEqual(ra, { text: "ok", usage: { input: 7, output: 3, totalTokens: 10 } });
	const rb = await adapter.runCompletionTurn(reqB.callId, reqB);
	assert.equal(rb.text, "ok");

	assert.deepEqual(
		createdTitles,
		[UTILITY_AGENT_ID],
		"exactly one creation: the standing utility agent, never per call",
	);
	assert.equal(runCalls.length, 2);
	assert.equal(runCalls[0]!.handleId, runCalls[1]!.handleId, "the same handle both calls — reused, never per-call");
	assert.notEqual(runCalls[0]!.text, runCalls[1]!.text);
	assert.ok(runCalls[0]!.text.includes("SYSTEM A"));
	assert.ok(runCalls[0]!.text.includes("TRANSCRIPT A"));
	assert.ok(runCalls[1]!.text.includes("SYSTEM B"));
	assert.ok(runCalls[1]!.text.includes("TRANSCRIPT B"));
	assert.ok(
		!runCalls[1]!.text.includes("TRANSCRIPT A"),
		"no carry-over of the previous call's payload",
	);

	// cancel: no live turn → false
	assert.equal(await adapter.cancelCompletionTurn("never"), false);
});
