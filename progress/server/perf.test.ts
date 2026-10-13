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

test("a log past its size cap stops growing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-perf-"));
  try {
    const log = join(dir, "perf.log");
    writeFileSync(log, "x".repeat(PERF_LOG_MAX_BYTES));
    await handleReportPerf({ lines: ["too late"] }, undefined as never, log);
    assert.ok(!readFileSync(log, "utf8").includes("too late"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the log sits beside the board stores, not inside them", () => {
  assert.match(perfLogPath({}), /\.local\/state\/paseo-progress-perf\.log$/);
  assert.equal(perfLogPath({ PASEO_PROGRESS_PERF_LOG: "/tmp/custom.log" }), "/tmp/custom.log");
});
