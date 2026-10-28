/**
 * THE BROKER CORE (learn-on-paseo P5 wave 3, Part B of
 * docs/p5/broker-contract-design.md): the v1 protocol listener for the
 * learn-broker plugin. ZERO @getpaseo/plugin imports — plain node:http —
 * so the whole protocol is testable in-process against a scripted
 * BrokerAgentPort double (the double-for-tests ruling; the real port is
 * server/paseo-adapter.ts, which maps onto the Paseo SDK).
 *
 * Contract version 1. One JSON envelope per response; every routed op is
 * logged to an append-only log (in memory + one JSONL file, dir
 * injectable for tests) and every op response carries its own log entry.
 * The Bearer token guard is fail-closed: no token configured means the
 * listener refuses to start at all, and a missing or wrong token on any
 * request is 401 — refused calls are not ops, so they log nothing.
 *
 * What the broker never has: no service data access, no learner-file
 * reach, no graph writes. It only creates/archives/reads agents and runs
 * completions through the port.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { DEFAULT_HOST } from "./config.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Contract version of this listener (docs/p5/broker-contract-design.md
 *  Part B.2: "The protocol (contract version 1)"). */
export const BROKER_CONTRACT_VERSION = 1;

/** Plain usage numbers — money accounting stays broker-side (mirrors the
 *  learn service's BrokerUsage; duplicated on purpose, licence law). */
export interface BrokerUsage {
	input: number;
	output: number;
	totalTokens: number;
}

/** The fully-resolved model pin the call runs on (mirrors BrokerModelPin). */
export interface BrokerModelPin {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

/** One transcript message in the routed span (mirrors BrokerMessage). */
export interface BrokerMessage {
	role: "user" | "assistant";
	content: string;
}

/** A model completion request routed through the broker (mirrors
 *  BrokerCompleteRequest — callId, purpose, model, systemPrompt,
 *  messages — plus the caller's timeoutMs, enforced broker-side). */
export interface BrokerCompleteRequest {
	callId: string;
	purpose: string;
	model: BrokerModelPin;
	systemPrompt?: string;
	messages: BrokerMessage[];
}

/** The conversation child's creation payload — LEAN by contract: exactly
 *  these five fields, never seat, label or guy machinery. */
export interface BrokerChildInput {
	tutorId: string;
	conversationId: string;
	personaPreps: string[];
	tools: string[];
	autoArchive: boolean;
}

/** The file-bridge config returned for the child (mirrors BridgeConfig;
 *  the plugin builds it from the service URL/token seam). */
export interface BrokerBridgeConfig {
	mcpServers: {
		learn: {
			type: "http";
			url: string;
			/** Optional by law: derived from the service token at runtime and
			 *  OMITTED when unset — the bridge never carries a half credential. */
			headers?: { Authorization?: string };
		};
	};
}

export type BrokerOp =
	| "ensure-tutor"
	| "child"
	| "archive"
	| "timeline"
	| "complete"
	| "cancel";

/** Honest error kinds only — never a fabricated reply (Part B.4). */
export type BrokerErrorKind =
	| "timeout"
	| "aborted"
	| "agent_error"
	| "transport"
	| "unauthorized"
	| "bad_request";

/** One append-only log entry. For complete ops this carries the
 *  BrokerCallLogEntry fields (seq, at, callId, purpose, model, ok,
 *  durationMs, textChars?, usage?, error?) plus the op name so lifecycle
 *  and completion acts share one log. */
export interface BrokerLogEntry {
	seq: number;
	/** ISO timestamp of the op's completion. */
	at: string;
	op: BrokerOp;
	/** Correlation id: workspaceId, conversationId, agentId or the
	 *  completion callId, per op. */
	callId: string;
	purpose: string;
	/** "provider:id" of the pinned model — complete ops only. */
	model?: string;
	ok: boolean;
	durationMs: number;
	textChars?: number;
	usage?: BrokerUsage;
	error?: string;
}

/** The one response envelope: every op response carries its log entry;
 *  refusals (401/400/404) and the log read carry log: null. */
export interface BrokerResponseEnvelope<T = unknown> {
	ok: boolean;
	data?: T;
	error?: { kind: BrokerErrorKind; message: string };
	log: BrokerLogEntry | null;
}

/** The narrow port the broker drives — implemented against the Paseo SDK
 *  by server/paseo-adapter.ts, scripted by the tests. */
export interface BrokerAgentPort {
	/** Idempotent: one standing tutor per workspace. */
	ensureTutor(workspaceId: string): Promise<{ tutorId: string; created: boolean }>;
	createConversationChild(
		input: BrokerChildInput,
	): Promise<{ childId: string; bridge: BrokerBridgeConfig }>;
	/** Archive an agent; false when the agent is unknown. */
	archiveAgent(agentId: string): Promise<boolean>;
	/** The agent's timeline. An archived agent reads only with
	 *  includeArchived — conclude must never lose the transcript. */
	readTimeline(
		agentId: string,
		opts?: { includeArchived?: boolean },
	): Promise<unknown[]>;
	/** One completion turn: text + usage out. Throws on agent failure. */
	runCompletionTurn(
		callId: string,
		request: BrokerCompleteRequest,
	): Promise<{ text: string; usage: BrokerUsage }>;
	/** Best-effort cancel of an in-flight turn; false when none is live. */
	cancelCompletionTurn(callId: string): Promise<boolean>;
}

export interface BrokerCoreOptions {
	/** The broker's own pairing token. Null/empty refuses to start —
	 *  fail-closed: no token, no listener, no ops. */
	token: string | null;
	/** The port implementation (paseo adapter in production, double in tests). */
	port: BrokerAgentPort;
	/** Log directory; the log is broker-log.jsonl inside it. Omit for
	 *  memory-only (tests pass a temp dir). */
	logDir?: string;
	/** Bind host. Defaults to loopback: a roaming laptop joins whatever wifi is
	 *  in range, so all interfaces would expose the listener on every one of
	 *  them. Widen it deliberately to a tailnet address. */
	host?: string;
	/** Bind port. Defaults to an ephemeral port. */
	listenPort?: number;
}

export interface BrokerCore {
	close(): Promise<void>;
	address(): { address: string; port: number } | null;
	/** The in-memory view of the append-only log (the file seeds it). */
	readLog(): readonly BrokerLogEntry[];
}

const MAX_BODY_BYTES = 1_048_576;
const LOG_FILE_NAME = "broker-log.jsonl";

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Append-only log: in memory, seeded from and appended to
 *  <logDir>/broker-log.jsonl when a dir is given. */
class BrokerLog {
	private entries: BrokerLogEntry[] = [];
	private readonly file: string | null;

	constructor(logDir?: string) {
		if (!logDir) {
			this.file = null;
			return;
		}
		mkdirSync(logDir, { recursive: true });
		this.file = join(logDir, LOG_FILE_NAME);
		if (existsSync(this.file)) {
			for (const line of readFileSync(this.file, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line) as BrokerLogEntry;
					if (typeof parsed.seq === "number" && typeof parsed.op === "string") {
						this.entries.push(parsed);
					}
				} catch {
					// A torn final line from a hard kill is skipped, never fatal.
				}
			}
		}
	}

	private nextSeq(): number {
		const last = this.entries[this.entries.length - 1];
		return (last?.seq ?? 0) + 1;
	}

	append(
		entry: Omit<BrokerLogEntry, "seq" | "at">,
	): BrokerLogEntry {
		const full: BrokerLogEntry = {
			...entry,
			seq: this.nextSeq(),
			at: new Date().toISOString(),
		};
		this.entries.push(full);
		if (this.file) appendFileSync(this.file, `${JSON.stringify(full)}\n`);
		return full;
	}

	all(): readonly BrokerLogEntry[] {
		return this.entries;
	}
}

/** Fail-closed Bearer guard: hash both sides so timingSafeEqual gets
 *  equal-length digests and the token never appears in a timing side
 *  channel. */
function tokenOk(header: string | undefined, expected: string): boolean {
	if (!header) return false;
	const match = /^Bearer\s+(.+)$/.exec(header);
	const presented = match?.[1] ?? "";
	if (!presented) return false;
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, envelope: BrokerResponseEnvelope): void {
	const body = JSON.stringify(envelope);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

function refuse(
	res: ServerResponse,
	status: number,
	kind: BrokerErrorKind,
	message: string,
): void {
	sendJson(res, status, { ok: false, error: { kind, message }, log: null });
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

function asBody(raw: string): Record<string, unknown> | null {
	if (raw.trim() === "") return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Validate the lean five-field child payload verbatim — extra fields
 *  break the leanness law, so they are refused, not silently dropped. */
function parseChildBody(body: Record<string, unknown>): BrokerChildInput | null {
	const keys = Object.keys(body).sort().join(",");
	if (keys !== "autoArchive,conversationId,personaPreps,tools,tutorId") return null;
	if (!isNonEmptyString(body.tutorId)) return null;
	if (!isNonEmptyString(body.conversationId)) return null;
	if (!Array.isArray(body.personaPreps) || body.personaPreps.some((p) => !isNonEmptyString(p))) return null;
	if (!Array.isArray(body.tools) || body.tools.some((t) => !isNonEmptyString(t))) return null;
	if (typeof body.autoArchive !== "boolean") return null;
	return {
		tutorId: body.tutorId,
		conversationId: body.conversationId,
		personaPreps: body.personaPreps as string[],
		tools: body.tools as string[],
		autoArchive: body.autoArchive,
	};
}

function parseCompleteBody(body: Record<string, unknown>): BrokerCompleteRequest | null {
	if (!isNonEmptyString(body.callId)) return null;
	if (!isNonEmptyString(body.purpose)) return null;
	const model = body.model;
	if (model === null || typeof model !== "object" || Array.isArray(model)) return null;
	const m = model as Record<string, unknown>;
	if (!isNonEmptyString(m.provider) || !isNonEmptyString(m.id)) return null;
	if (body.systemPrompt !== undefined && !isNonEmptyString(body.systemPrompt)) return null;
	if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
	for (const msg of body.messages) {
		if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return null;
		const mm = msg as Record<string, unknown>;
		if ((mm.role !== "user" && mm.role !== "assistant") || !isNonEmptyString(mm.content)) return null;
	}
	return {
		callId: body.callId,
		purpose: body.purpose,
		model: { provider: m.provider, id: m.id },
		messages: body.messages as BrokerMessage[],
		...(isNonEmptyString(body.systemPrompt) ? { systemPrompt: body.systemPrompt } : {}),
	};
}

interface InflightComplete {
	cancelSent: boolean;
	outcome: "none" | "timeout" | "aborted";
}

/** Start the v1 broker listener. */
export async function startBrokerCore(opts: BrokerCoreOptions): Promise<BrokerCore> {
	const expectedToken = opts.token;
	if (!expectedToken) {
		// Fail-closed: no token configured means refuse everything —
		// the listener never opens a socket at all.
		throw new Error(
			"learn-broker: no LEARN_BROKER_TOKEN configured — fail-closed, refusing to start",
		);
	}
	const log = new BrokerLog(opts.logDir);
	// callId -> in-flight state for complete/cancel coordination.
	const inflight = new Map<string, InflightComplete>();
	const timers = new Set<ReturnType<typeof setTimeout>>();

	const server: Server = createServer((req, res) => {
		void handle(req, res).catch((err: unknown) => {
			// Handler-level fault (body read failure etc.): honest transport error.
			if (!res.headersSent) {
				refuse(res, 500, "transport", messageOf(err));
			} else {
				res.end();
			}
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://broker.invalid");
		const path = url.pathname;
		const method = req.method ?? "";

		if (!tokenOk(req.headers.authorization, expectedToken!)) {
			refuse(res, 401, "unauthorized", "missing or wrong bearer token");
			return;
		}

		// --- op routes (each answers 200 with the op envelope) ---

		const runOp = async <T>(
			op: BrokerOp,
			callId: string,
			purpose: string,
			fn: () => Promise<T>,
		): Promise<void> => {
			const started = Date.now();
			try {
				const data = await fn();
				const entry = log.append({
					op,
					callId,
					purpose,
					ok: true,
					durationMs: Date.now() - started,
				});
				sendJson(res, 200, { ok: true, data, log: entry });
			} catch (err) {
				const entry = log.append({
					op,
					callId,
					purpose,
					ok: false,
					durationMs: Date.now() - started,
					error: messageOf(err),
				});
				sendJson(res, 200, {
					ok: false,
					error: { kind: "agent_error", message: messageOf(err) },
					log: entry,
				});
			}
		};

		if (method === "POST" && path === "/v1/agents/ensure-tutor") {
			const body = asBody(await readBody(req));
			if (!body || !isNonEmptyString(body.workspaceId)) {
				refuse(res, 400, "bad_request", "expected {workspaceId}");
				return;
			}
			await runOp("ensure-tutor", body.workspaceId, "ensure standing tutor", () =>
				opts.port.ensureTutor(body.workspaceId as string),
			);
			return;
		}

		if (method === "POST" && path === "/v1/agents/child") {
			const body = asBody(await readBody(req));
			const input = body ? parseChildBody(body) : null;
			if (!input) {
				refuse(
					res,
					400,
					"bad_request",
					"expected the lean five-field payload {tutorId, conversationId, personaPreps, tools, autoArchive} — no extra fields",
				);
				return;
			}
			await runOp("child", input.conversationId, "create conversation child", () =>
				opts.port.createConversationChild(input),
			);
			return;
		}

		const archiveMatch = /^\/v1\/agents\/([^/]+)\/archive$/.exec(path);
		if (method === "POST" && archiveMatch) {
			const agentId = decodeURIComponent(archiveMatch[1] ?? "");
			await runOp("archive", agentId, "archive agent", async () => ({
				archived: await opts.port.archiveAgent(agentId),
			}));
			return;
		}

		const timelineMatch = /^\/v1\/agents\/([^/]+)\/timeline$/.exec(path);
		if (method === "GET" && timelineMatch) {
			const agentId = decodeURIComponent(timelineMatch[1] ?? "");
			const includeArchived = url.searchParams.get("includeArchived") === "true";
			await runOp("timeline", agentId, "read timeline", async () => ({
				entries: await opts.port.readTimeline(agentId, { includeArchived }),
			}));
			return;
		}

		if (method === "POST" && path === "/v1/complete") {
			const body = asBody(await readBody(req));
			const parsed = body ? parseCompleteBody(body) : null;
			const timeoutMs = body?.timeoutMs;
			if (!parsed || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				refuse(res, 400, "bad_request", "expected a completion request with a positive timeoutMs");
				return;
			}
			await runComplete(res, parsed, timeoutMs);
			return;
		}

		const cancelMatch = /^\/v1\/complete\/([^/]+)$/.exec(path);
		if (method === "DELETE" && cancelMatch) {
			const callId = decodeURIComponent(cancelMatch[1] ?? "");
			await runOp("cancel", callId, "cancel completion", async () => {
				const pending = inflight.get(callId);
				const cancelled = await opts.port.cancelCompletionTurn(callId);
				if (pending && cancelled && !pending.cancelSent) {
					// The port accepted the cancel; the waiter answers aborted
					// unless the broker-side timer already claimed it as timeout.
					pending.cancelSent = true;
					if (pending.outcome === "none") pending.outcome = "aborted";
				}
				return { cancelled };
			});
			return;
		}

		if (method === "GET" && path === "/v1/log") {
			// Reading the audit log is not an audited op: no entry, no growth.
			sendJson(res, 200, {
				ok: true,
				data: { contractVersion: BROKER_CONTRACT_VERSION, entries: log.all() },
				log: null,
			});
			return;
		}

		refuse(res, 404, "transport", `no such route: ${method} ${path}`);
	}

	/** The completion op with broker-side timeout enforcement (Part B.4):
	 *  a turn that exceeds timeoutMs is cancelled on the port and answered
	 *  with an honest timeout error; an explicit DELETE cancel answers
	 *  aborted; a late port resolution is dropped, never logged as a
	 *  fabricated reply. */
	async function runComplete(
		res: ServerResponse,
		request: BrokerCompleteRequest,
		timeoutMs: number,
	): Promise<void> {
		const started = Date.now();
		const state: InflightComplete = { cancelSent: false, outcome: "none" };
		inflight.set(request.callId, state);
		const timer = setTimeout(() => {
			state.outcome = "timeout";
			if (!state.cancelSent) {
				state.cancelSent = true;
				void opts.port.cancelCompletionTurn(request.callId).catch(() => {});
			}
		}, timeoutMs);
		timers.add(timer);
		const finish = (
			envelope: BrokerResponseEnvelope<{
				text: string;
				usage: BrokerUsage;
			}>,
		): void => {
			clearTimeout(timer);
			timers.delete(timer);
			inflight.delete(request.callId);
			if (!res.headersSent) sendJson(res, 200, envelope);
		};
		try {
			const result = await opts.port.runCompletionTurn(request.callId, request);
			if (state.outcome !== "none") {
				// The cancel already answered (or is answering) this call; the
				// late turn result is dropped — the log never records a
				// fabricated reply.
				finish(timeoutEnvelope(request, state.outcome, started));
				return;
			}
			const entry = log.append({
				op: "complete",
				callId: request.callId,
				purpose: request.purpose,
				model: `${request.model.provider}:${request.model.id}`,
				ok: true,
				durationMs: Date.now() - started,
				textChars: result.text.length,
				usage: result.usage,
			});
			finish({ ok: true, data: result, log: entry });
		} catch (err) {
			if (state.outcome !== "none") {
				finish(timeoutEnvelope(request, state.outcome, started));
				return;
			}
			const entry = log.append({
				op: "complete",
				callId: request.callId,
				purpose: request.purpose,
				model: `${request.model.provider}:${request.model.id}`,
				ok: false,
				durationMs: Date.now() - started,
				error: messageOf(err),
			});
			finish({
				ok: false,
				error: { kind: "agent_error", message: messageOf(err) },
				log: entry,
			});
		}
	}

	function timeoutEnvelope(
		request: BrokerCompleteRequest,
		outcome: "timeout" | "aborted",
		started: number,
	): BrokerResponseEnvelope<{ text: string; usage: BrokerUsage }> {
		const message =
			outcome === "timeout"
				? `completion exceeded the caller's timeoutMs and was cancelled broker-side (callId ${request.callId})`
				: `completion was cancelled by a DELETE cancel op (callId ${request.callId})`;
		const entry = log.append({
			op: "complete",
			callId: request.callId,
			purpose: request.purpose,
			model: `${request.model.provider}:${request.model.id}`,
			ok: false,
			durationMs: Date.now() - started,
			error: message,
		});
		return { ok: false, error: { kind: outcome, message }, log: entry };
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		// Loopback unless the deployment says otherwise. See config.ts.
		server.listen(opts.listenPort ?? 0, opts.host ?? DEFAULT_HOST, () => resolve());
	});

	return {
		async close(): Promise<void> {
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			inflight.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
		address(): { address: string; port: number } | null {
			const addr = server.address();
			return addr && typeof addr === "object" ? { address: addr.address, port: addr.port } : null;
		},
		readLog: () => log.all(),
	};
}
