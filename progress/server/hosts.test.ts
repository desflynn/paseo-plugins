import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackSnapshot, isWorthCaching, readCachedSnapshot, shortLabel, writeSnapshot, type HostSnapshot } from "./hosts.ts";

const snapshot = (over: Partial<HostSnapshot> = {}): HostSnapshot => ({
  serverId: "srv_korolev",
  label: "korolev",
  status: "online",
  boards: { wks_1: null },
  at: "2026-10-25T15:00:00.000Z",
  stale: false,
  ...over,
});

const dir = () => mkdtempSync(join(tmpdir(), "progress-hosts-"));

describe("shortLabel — the machine tag Des sees", () => {
  test("the real host labels read as three letters", () => {
    assert.equal(shortLabel("korolev"), "KOR");
    assert.equal(shortLabel("dgx-spark"), "DGX");
    assert.equal(shortLabel("ideapad"), "IDE");
    assert.equal(shortLabel("Mac Studio"), "MAC");
  });

  test("an unusable label never renders empty", () => {
    assert.equal(shortLabel(""), "?");
    assert.equal(shortLabel("---"), "?");
  });
});

describe("snapshot cache — an offline host keeps its last good board", () => {
  test("a written snapshot reads back marked stale", () => {
    const d = dir();
    writeSnapshot(d, snapshot());
    const read = readCachedSnapshot(d, "srv_korolev");
    assert.ok(read);
    assert.equal(read.stale, true);
    assert.deepEqual(read.boards, { wks_1: null });
  });

  test("a failed read falls back to the cache", () => {
    const d = dir();
    writeSnapshot(d, snapshot());
    const fallback = fallbackSnapshot(d, { serverId: "srv_korolev", label: "korolev", status: "offline" }, "2026-10-25T16:00:00.000Z");
    assert.equal(fallback.stale, true);
    assert.deepEqual(fallback.boards, { wks_1: null });
    assert.equal(fallback.at, "2026-10-25T15:00:00.000Z");
  });

  test("an offline host with no cache still appears, with no boards", () => {
    const fallback = fallbackSnapshot(dir(), { serverId: "srv_dgx", label: "dgx-spark", status: "offline" }, "2026-10-25T16:00:00.000Z");
    assert.deepEqual(fallback.boards, {});
    assert.equal(fallback.stale, true);
  });

  test("an empty read never overwrites a good cache", () => {
    const d = dir();
    writeSnapshot(d, snapshot());
    writeSnapshot(d, snapshot({ boards: {}, at: "2026-10-25T17:00:00.000Z" }));
    assert.equal(readCachedSnapshot(d, "srv_korolev")?.at, "2026-10-25T15:00:00.000Z");
    assert.equal(isWorthCaching(snapshot({ boards: {} })), false);
  });

  test("a corrupt cache file reads as no cache rather than throwing", () => {
    const d = dir();
    writeFileSync(join(d, "srv_korolev.json"), "{not json", "utf8");
    assert.equal(readCachedSnapshot(d, "srv_korolev"), null);
  });
});
