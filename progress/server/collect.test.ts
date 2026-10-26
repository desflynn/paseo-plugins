import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHosts, type HostTarget } from "./collect.ts";
import { writeSnapshot } from "./hosts.ts";
import type { BoardSummary } from "../shared/overview.ts";

type Boards = Record<string, BoardSummary | null>;

const dir = () => mkdtempSync(join(tmpdir(), "progress-collect-"));
const NOW = "2026-10-25T17:00:00.000Z";

const korolev: HostTarget = { serverId: "srv_k", label: "korolev", status: "online" };
const dgx: HostTarget = { serverId: "srv_d", label: "dgx-spark", status: "online" };
const pad: HostTarget = { serverId: "srv_i", label: "ideapad", status: "offline" };

describe("collectHosts — the Everything fan-out", () => {
  test("reads every host and keeps each board map apart", async () => {
    const read = async (host: HostTarget): Promise<Boards> => (host.serverId === "srv_k" ? { wks_k: null } : { wks_d: null });
    const out = await collectHosts([korolev, dgx], read, dir(), NOW);
    assert.deepEqual(out.map((s) => Object.keys(s.boards)), [["wks_k"], ["wks_d"]]);
    assert.equal(out.every((s) => s.stale === false), true);
  });

  test("one host failing does not stop the others", async () => {
    const read = async (host: HostTarget): Promise<Boards> => {
      if (host.serverId === "srv_d") throw new Error("ssh timed out");
      return { wks_k: null };
    };
    const out = await collectHosts([korolev, dgx], read, dir(), NOW);
    assert.equal(out[0]!.stale, false);
    assert.equal(out[1]!.stale, true);
    assert.deepEqual(out[0]!.boards, { wks_k: null });
  });

  test("a failing host serves its cached snapshot when one exists", async () => {
    const d = dir();
    writeSnapshot(d, { serverId: "srv_d", label: "dgx-spark", status: "online", boards: { wks_d: null }, at: "2026-10-25T15:00:00.000Z", stale: false });
    const read = async (): Promise<Boards> => {
      throw new Error("host offline");
    };
    const out = await collectHosts([dgx], read, d, NOW);
    assert.equal(out[0]!.stale, true);
    assert.equal(out[0]!.at, "2026-10-25T15:00:00.000Z");
    assert.deepEqual(out[0]!.boards, { wks_d: null });
  });

  test("an offline host with no cache still contributes a row with no boards", async () => {
    const read = async (): Promise<Boards> => {
      throw new Error("host offline");
    };
    const out = await collectHosts([pad], read, dir(), NOW);
    assert.equal(out[0]!.serverId, "srv_i");
    assert.equal(out[0]!.label, "ideapad");
    assert.equal(out[0]!.stale, true);
    assert.deepEqual(out[0]!.boards, {});
  });

  test("a host with an empty read is not written over its cache", async () => {
    const d = dir();
    writeSnapshot(d, { serverId: "srv_k", label: "korolev", status: "online", boards: { wks_k: null }, at: "2026-10-25T15:00:00.000Z", stale: false });
    const out = await collectHosts([korolev], async (): Promise<Boards> => ({}), d, NOW);
    assert.deepEqual(out[0]!.boards, {});
    const cached = await collectHosts([korolev], async (): Promise<Boards> => {
      throw new Error("down");
    }, d, NOW);
    assert.deepEqual(cached[0]!.boards, { wks_k: null });
  });
});
