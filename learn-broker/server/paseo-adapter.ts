/**
 * THE PASEO ADAPTER (learn-on-paseo P5 wave 3): the real BrokerAgentPort
 * for the learn-broker plugin, mapping the broker protocol onto the Paseo
 * SDK surface an authenticated plugin subprocess receives.
 *
 * Licence law honoured here: fresh implementation, and the SDK surface is
 * MIRRORED as a minimal structural interface (PaseoSdkApi below) —
 * duplicated on purpose, no @getpaseo imports, nothing imported from the
 * learn tree. When the plugin lands in PP's repo, this mirror is what
 * keeps broker-core testable with zero SDK installs.
 *
 * Gate ruling 2 lives here: complete() runs on ONE REUSED lean utility
 * agent (id UTILITY_AGENT_ID) — created once per daemon, never per call —
 * with fresh, fully self-contained instructions per call, so state bleed
 * between calls is structurally impossible: nothing of one call survives
 * in the instruction of the next. Calls are serialized on the single
 * utility agent. Cancellation uses the SDK's documented interrupt lever
 * (a send while mid-turn interrupts the active turn by daemon default).
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	BrokerAgentPort,
	BrokerBridgeConfig,
	BrokerChildInput,
	BrokerCompleteRequest,
	BrokerUsage,
} from "./broker-core.ts";

/** The one standing lean broker-utility agent per daemon (ruling 2). */
export const UTILITY_AGENT_ID = "learn-broker-utility";

const UTILITY_LABEL = "learn-broker-utility";
const TUTOR_LABEL = "learn-tutor";
const CONVERSATION_LABEL = "learn-conversation";

// --- minimal structural mirror of the Paseo SDK (duplicated on purpose) ---

export interface PaseoSdkRunResult {
	status: "idle" | "permission" | "error" | "timeout";
	lastMessage?: string | null;
	error?: string | null;
}

export interface PaseoSdkAgentUsage {
	inputTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	totalCostUsd?: number;
}

export interface PaseoSdkAgentHandle {
	id: string;
	workspaceId?: string | null;
	/** Token counts from the last observed turn (AgentUsage mirror). */
	lastUsage: PaseoSdkAgentUsage | null;
	/** Sends a prompt and waits for that turn; default wait 10 minutes. */
	run(text: string, opts?: { timeoutMs?: number }): Promise<PaseoSdkRunResult>;
	/** A send while the agent is mid-turn interrupts the turn when
	 *  activeTurnBehavior is omitted or "interrupt" — the cancel lever. */
	send(
		text: string,
		opts?: { activeTurnBehavior?: "interrupt" | "steer" },
	): Promise<void>;
	waitForFinish(timeoutMs?: number): Promise<PaseoSdkRunResult>;
	/** Never contacts the daemon from ref(); fetches the snapshot onto the
	 *  handle — placement then reads as handle PROPERTIES (docs shape:
	 *  refresh() returns nothing; workspaceId is a property, null until a
	 *  snapshot arrives; an unknown agent makes refresh() throw). */
	refresh(): Promise<void>;
	archive(): Promise<void>;
	timeline: {
		refetch(opts?: { includeArchived?: boolean }): Promise<{ entries: unknown[] }>;
	};
}

export interface PaseoSdkCreateOptions {
	config: {
		provider?: string;
		mcpServers?: unknown;
		tools?: string[];
	};
	/** The daemon requires it on top-level creates ("createAgent requires
	 *  provider and cwd") — an existing, lawful directory. */
	cwd?: string;
	parent?: PaseoSdkAgentHandle;
	title?: string;
	prompt?: string;
	autoArchive?: boolean;
	labels?: Record<string, string>;
}

export interface PaseoSdkApi {
	agents: {
		create(opts: PaseoSdkCreateOptions): Promise<PaseoSdkAgentHandle>;
		ref(id: string): PaseoSdkAgentHandle;
		list(opts?: {
			filter?: { labels?: Record<string, string> };
		}): Promise<{
			entries: Array<{
				agent: { id: string; labels?: Record<string, string> };
			}>;
		}>;
	};
	workspaces: {
		ref(id: string): {
			agents: { create(opts: PaseoSdkCreateOptions): Promise<PaseoSdkAgentHandle> };
		};
	};
}

export interface PaseoBrokerAdapterOptions {
	/** Provider pin for broker-created agents; omit to let the daemon
	 *  default apply (the deployment decides via the plugin shell). */
	provider?: string;
	/** Builds the file-bridge config a conversation child receives — from
	 *  the service URL/token env seam in the shell, never a literal. */
	resolveBridge: () => BrokerBridgeConfig;
}

function toUsage(u: PaseoSdkAgentUsage | null): BrokerUsage {
	const input = u?.inputTokens ?? 0;
	const output = u?.outputTokens ?? 0;
	return { input, output, totalTokens: input + output };
}

/** Fresh, fully self-contained instructions per call (ruling 2): the
 *  system prompt and the whole routed transcript travel inside the one
 *  instruction — no carry-over from any previous call is possible,
 *  because nothing else is referenced. */
export function buildInstruction(request: BrokerCompleteRequest): string {
	const parts: string[] = [
		"You are the learn broker utility agent. Execute the completion call below exactly as instructed and reply with the completion text only — no preamble.",
	];
	if (request.systemPrompt) {
		parts.push(`System instructions:\n${request.systemPrompt}`);
	}
	parts.push(
		`Transcript:\n${request.messages
			.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`)
			.join("\n\n")}`,
	);
	parts.push("Reply now with the completion text only.");
	return parts.join("\n\n");
}

export function createPaseoBrokerAdapter(
	paseo: PaseoSdkApi,
	opts: PaseoBrokerAdapterOptions,
): BrokerAgentPort {
	// The one REUSED utility agent (ruling 2) — created lazily once.
	let utility: PaseoSdkAgentHandle | null = null;
	// complete() calls are serialized on the single utility agent.
	let chain: Promise<unknown> = Promise.resolve();
	// callId -> live turn record, for cancel.
	const turns = new Map<
		string,
		{ handle: PaseoSdkAgentHandle; done: boolean }
	>();

	async function ensureUtility(requestModel?: { provider: string; id: string }): Promise<PaseoSdkAgentHandle> {
		if (utility) return utility;
		// Reattach if a previous daemon life left one standing.
		const page = await paseo.agents.list({
			filter: { labels: { [UTILITY_LABEL]: "true" } },
		});
		const found = page.entries[0];
		if (found) {
			utility = paseo.agents.ref(found.agent.id);
			return utility;
		}
		// Provider derivation (captain's ruling 81238ebf): the request's
		// model in harness-first form wins, else the env pin, else an
		// honest refusal naming what was missing. The daemon takes the
		// combined "harness/model" string in config.provider.
		let provider: string | undefined;
		if (requestModel && requestModel.id.includes("/")) {
			provider = `${requestModel.provider}/${requestModel.id}`;
		} else if (opts.provider) {
			provider = opts.provider;
		}
		if (!provider) {
			throw new Error(
				"complete(): no usable model pin — the request model is not harness-first and LEARN_BROKER_PROVIDER is unset (refusing, fail-closed)",
			);
		}
		// The utility agent's lawful cwd: the box's ~/.learnharness (it
		// exists — the plugin's env file lives there); created defensively.
		const cwd = join(homedir(), ".learnharness");
		mkdirSync(cwd, { recursive: true });
		const created = await paseo.agents.create({
			config: { provider },
			cwd,
			title: UTILITY_AGENT_ID,
			autoArchive: false,
			labels: { [UTILITY_LABEL]: "true" },
		});
		utility = created;
		return created;
	}

	async function doRun(
		callId: string,
		request: BrokerCompleteRequest,
	): Promise<{ text: string; usage: BrokerUsage }> {
		const handle = await ensureUtility(request.model);
		const record = { handle, done: false };
		turns.set(callId, record);
		try {
			const result = await handle.run(buildInstruction(request));
			// Audit-falsity fix (checkpilot's blocking finding): run()'s result
			// carries the turn outcome, but the usage snapshot arrives on the
			// HANDLE — deliver it with a best-effort refresh() before reading
			// lastUsage, so the broker log records the REAL turn's tokens.
			try {
				await handle.refresh();
			} catch {
				// never fail a completed turn on a refresh error; usage then
				// reads whatever the handle last observed (honest either way)
			}
			const usage = toUsage(handle.lastUsage);
			if (result.status === "idle" && typeof result.lastMessage === "string") {
				// agentId names the agent the turn ran on — the standing
				// utility agent — the complete path's scope naming for the
				// core's log entry (the broker log is the scope).
				return { text: result.lastMessage, usage, agentId: handle.id };
			}
			if (result.status === "timeout") {
				throw new Error(`utility turn wait elapsed (callId ${callId})`);
			}
			if (result.status === "permission") {
				throw new Error(
					`utility turn is blocked on a permission answer (callId ${callId})`,
				);
			}
			throw new Error(
				result.error ?? `utility turn ended with status ${result.status} (callId ${callId})`,
			);
		} finally {
			record.done = true;
			turns.delete(callId);
		}
	}

	const port: BrokerAgentPort = {
		async ensureTutor(workspaceId) {
			// The derived-id return: the response always names the workspace.
			// A given id is echoed verbatim; an omission is derived from the
			// standing tutor's own placement (the same internal read the child
			// path uses) — with nothing to derive from, an honest refusal.
			if (workspaceId === undefined) {
				const all = await paseo.agents.list();
				const standing = all.entries.find(
					(e) => e.agent.labels?.[TUTOR_LABEL] !== undefined,
				);
				if (!standing) {
					throw new Error(
						"ensureTutor(): no workspaceId given and no standing tutor to derive one from — refusing, fail-closed",
					);
				}
				const ref = paseo.agents.ref(standing.agent.id);
				await ref.refresh();
				if (!ref.workspaceId) {
					throw new Error(
						`ensureTutor(): standing tutor ${standing.agent.id} has no workspace placement to derive one from`,
					);
				}
				return { tutorId: standing.agent.id, created: false, workspaceId: ref.workspaceId };
			}
			const page = await paseo.agents.list({
				filter: { labels: { [TUTOR_LABEL]: workspaceId } },
			});
			const existing = page.entries[0];
			if (existing) return { tutorId: existing.agent.id, created: false, workspaceId };
			const workspace = paseo.workspaces.ref(workspaceId);
			const tutor = await workspace.agents.create({
				config: { ...(opts.provider ? { provider: opts.provider } : {}) },
				title: "Learn tutor",
				autoArchive: false,
				labels: { [TUTOR_LABEL]: workspaceId },
			});
			return { tutorId: tutor.id, created: true, workspaceId };
		},

		async createConversationChild(input: BrokerChildInput) {
			const bridge = opts.resolveBridge();
			const tutorRef = paseo.agents.ref(input.tutorId);
			await tutorRef.refresh();
			if (!tutorRef.workspaceId) {
				throw new Error(`tutor ${input.tutorId} has no workspace placement`);
			}
			const workspace = paseo.workspaces.ref(tutorRef.workspaceId);
			const child = await workspace.agents.create({
				config: {
					...(opts.provider ? { provider: opts.provider } : {}),
					mcpServers: bridge.mcpServers,
					tools: input.tools,
				},
				parent: tutorRef,
				title: `Learn conversation ${input.conversationId}`,
				prompt:
					input.personaPreps.length > 0
						? input.personaPreps.join("\n\n")
						: undefined,
				autoArchive: input.autoArchive,
				labels: { [CONVERSATION_LABEL]: input.conversationId },
			});
			return { childId: child.id, bridge };
		},

		async archiveAgent(agentId) {
			const ref = paseo.agents.ref(agentId);
			try {
				await ref.refresh(); // unknown agent: throws
			} catch {
				return false;
			}
			await ref.archive();
			return true;
		},

		async readTimeline(agentId, readOpts) {
			const ref = paseo.agents.ref(agentId);
			const includeArchived = readOpts?.includeArchived === true;
			const page = await ref.timeline.refetch(
				includeArchived ? { includeArchived: true } : undefined,
			);
			return page.entries;
		},

		runCompletionTurn(callId, request) {
			// Serialize on the one utility agent; keep the chain alive when a
			// call fails so later calls still run.
			const run = chain.then(() => doRun(callId, request));
			chain = run.catch(() => {});
			return run;
		},

		async cancelCompletionTurn(callId) {
			const record = turns.get(callId);
			if (!record || record.done) return false;
			turns.delete(callId);
			record.done = true;
			// The documented interrupt lever: a mid-turn send interrupts the
			// active turn (daemon default), then the tiny drain turn finishes.
			void record.handle
				.send(`[learn-broker] call ${callId} was cancelled by its caller — stop.`, {
					activeTurnBehavior: "interrupt",
				})
				.catch(() => {});
			void record.handle.waitForFinish(60_000).catch(() => {});
			return true;
		},

		async sendToAgent(agentId, text) {
			// The daemon's agent-send, verbatim: fire-and-forget sendPrompt;
			// the turn runs on the daemon (default interrupt semantics).
			// Scoping does NOT live here (Phase 6 ruling: the broker log is
			// the scope) — the core checked its own log BEFORE calling this,
			// so this forward runs only for ids the core already proved
			// broker-created; no daemon list read, no page caps.
			await paseo.agents.ref(agentId).send(text);
		},
	};

	return port;
}
