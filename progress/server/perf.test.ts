// The panel's freeze evidence lands in a plain log file the maintainer reads (o24).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleReportPerf, perfLogPath, PERF_LOG_MAX_BYTES } from "./perf.ts";

test("reported lines are appended, one per line, in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-perf-"));
  try {
    const log = join(dir, "perf.log");
    await handleReportPerf({ lines: ["first", "second"] }, undefined as never, log);
    await handleReportPerf({ lines: ["third"] }, undefined as never, log);
    assert.equal(readFileSync(log, "utf8"), "first\nsecond\nthird\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a full log keeps a readable tail and the new lines", async () => {
  // o47: a log that silently drops every line goes blind, and we lose the
  // evidence exactly when we need it. Past the cap, keep the newest lines that
  // fit, cut on a line start, then carry on.
  const dir = mkdtempSync(join(tmpdir(), "pp-perf-"));
  try {
    const log = join(dir, "perf.log");
    const old = Array.from({ length: 1000 }, (_, index) => `old line ${index} ${"x".repeat(2000)}`).join("\n") + "\n";
    writeFileSync(log, old);
    await handleReportPerf({ lines: ["fresh line"] }, undefined as never, log, 100_000);
    const text = readFileSync(log, "utf8");
    assert.ok(text.includes("fresh line"), "the new line lands");
    assert.ok(text.includes("old line 999"), "the newest old line survives");
    assert.ok(!text.includes("old line 0 "), "the oldest lines are dropped");
    assert.ok(text.length <= 150_000, "the log comes back under its cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the log sits beside the board stores, not inside them", () => {
  assert.match(perfLogPath({}), /\.local\/state\/paseo-progress-perf\.log$/);
  assert.equal(perfLogPath({ PASEO_PROGRESS_PERF_LOG: "/tmp/custom.log" }), "/tmp/custom.log");
});
