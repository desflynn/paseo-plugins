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
