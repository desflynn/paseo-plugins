import assert from "node:assert/strict";
import { test } from "node:test";
import { foldBoards, hostCommand } from "./everything.ts";

// docker exec takes argv, not a shell line. A quoted script reaches bash with the
// quotes still on it, so the helper never runs and the host looks dead in 114ms.
test("docker targets hand bash the script, not a quoted shell line", () => {
  const { bin, args } = hostCommand("docker:korolev");
  assert.equal(bin, "docker");
  assert.deepEqual(args.slice(0, 3), ["exec", "korolev", "bash"]);
  assert.equal(args[3], "-lc");
  assert.ok(!args[4]!.startsWith("'"), "script must not be wrapped in literal quotes");
  assert.ok(args[4]!.includes("paseo-boards"));
});

// ssh rejoins its arguments for a remote shell, so the quoted form stays.
test("ssh targets keep the quoted shell line", () => {
  const { bin, args } = hostCommand("des@dgx-spark");
  assert.equal(bin, "ssh");
  assert.equal(args[args.length - 1]!.startsWith("bash -lc '"), true);
});

// 17 state folders hold 92 boards on this box: one folder holds one board per
// workspace, so keying by folder alone silently loses 75 boards.
test("two boards in one state folder both survive the fold", () => {
  const folded = foldBoards({
    boards: [
      { cwd: "/repo/a", directory: "/state/a", title: "Run one", summary: { open: 1 } },
      { cwd: "/repo/a", directory: "/state/a", title: "Run two", summary: { open: 2 } },
    ],
  } as never);
  assert.equal(Object.keys(folded).length, 2);
});
