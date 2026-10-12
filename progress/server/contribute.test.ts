// The server wiring: every shared RPC contract gets exactly one handler.
// T13's detail RPCs (getBeadDetail, setBeadStatus, upgradeBead) were built
// but their registration was parked — this is the proof all three ride the
// same bus as the pre-existing contracts, each with a callable handler.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientHarness } from "../../test-support/client-harness.mjs";

const directory = new URL("../", import.meta.url).pathname;

test("the server contributes the beads detail RPCs alongside the rest", () => {
  const h = clientHarness(directory, {});
  const module = h.load("index.server.ts") as { default(server: unknown): unknown };
  assert.equal(typeof module.default, "function", "index.server.ts default-exports its contribute");
  const registered: Array<{ name: string; handler: unknown }> = [];
  module.default({ handle: (rpc: { name: string }, handler: unknown) => registered.push({ name: rpc.name, handler }) });
  const names = registered.map((entry) => entry.name);
  for (const name of ["progress.beads", "progress.beads.detail", "progress.beads.status", "progress.beads.upgrade"]) {
    const entry = registered.find((candidate) => candidate.name === name);
    assert.ok(entry, `${name} is not registered`);
    assert.equal(typeof entry.handler, "function", `${name} carries a callable handler`);
  }
  for (const name of ["progress.get", "progress.attention", "progress.panel.opened"]) {
    assert.ok(names.includes(name), `the pre-existing ${name} registration went missing`);
  }
});
