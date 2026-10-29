// The Learn page's rendering rules: a payload becomes rows here, so a shape
// the service changes renders defensively instead of crashing the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldRows, sessionRows, tutorIdentity, versionLine } from "./shape.ts";

test("fieldRows: primitives pass through, arrays count, nested values compact, key order holds", () => {
	const rows = fieldRows({ serviceVersion: "0.3.5", contractVersion: 1, live: true, sessions: [1, 2, 3], totals: { nodes: 12, edges: 30 }, missing: null });
	assert.deepEqual(rows, [
		{ key: "serviceVersion", text: "0.3.5" },
		{ key: "contractVersion", text: "1" },
		{ key: "live", text: "true" },
		{ key: "sessions", text: "3 items" },
		{ key: "totals", text: '{"nodes":12,"edges":30}' },
		{ key: "missing", text: "—" },
	]);
});

test("fieldRows: non-objects render nothing; the limit holds", () => {
	assert.deepEqual(fieldRows("nope"), []);
	assert.deepEqual(fieldRows(null), []);
	assert.deepEqual(fieldRows([1, 2]), []);
	const wide: Record<string, number> = {};
	for (let index = 0; index < 20; index += 1) wide[`k${index}`] = index;
	assert.equal(fieldRows(wide).length, 8);
});

test("sessionRows: a bare array and a wrapped list both read, missing fields render null", () => {
	const bare = sessionRows([{ id: "s1", title: "Ohm's law", status: "concluded", childAgentId: "child-7" }]);
	assert.deepEqual(bare, [{ id: "s1", label: "Ohm's law", status: "concluded", childAgentId: "child-7", at: null }]);
	const wrapped = sessionRows({ sessions: [{ conversationId: "c9" }] });
	assert.deepEqual(wrapped, [{ id: "c9", label: "c9", status: null, childAgentId: null, at: null }]);
	assert.deepEqual(sessionRows({ sessions: "no" }), []);
	assert.deepEqual(sessionRows(42), []);
});

test("sessionRows: most recent first when every row carries a time; original order otherwise", () => {
	const withTimes = sessionRows([
		{ id: "old", at: "2026-10-01T10:00:00Z" },
		{ id: "new", at: "2026-10-28T10:00:00Z" },
		{ id: "mid", at: 1772000000 },
	]);
	assert.deepEqual(withTimes.map((row) => row.id), ["new", "old", "mid"]);
	const without = sessionRows([{ id: "first" }, { id: "second" }]);
	assert.deepEqual(without.map((row) => row.id), ["first", "second"]);
});

test("versionLine: service and contract join; anything missing drops out", () => {
	assert.equal(versionLine({ serviceVersion: "0.3.5", contractVersion: 1 }), "service 0.3.5 · contract 1");
	assert.equal(versionLine({ version: "9" }), "service 9");
	assert.equal(versionLine({ contractVersion: 2 }), "contract 2");
	assert.equal(versionLine({}), null);
	assert.equal(versionLine("nope"), null);
});

test("tutorIdentity: id and status where the surface carries them", () => {
	assert.deepEqual(tutorIdentity({ id: "tutor-9", status: "idle" }), { id: "tutor-9", status: "idle" });
	assert.deepEqual(tutorIdentity({ tutorId: "t1", state: "teaching" }), { id: "t1", status: "teaching" });
	assert.deepEqual(tutorIdentity({}), { id: null, status: null });
	assert.deepEqual(tutorIdentity(null), { id: null, status: null });
});
