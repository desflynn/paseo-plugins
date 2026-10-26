import assert from "node:assert/strict";
import { test } from "node:test";
import { foldBoards, hostCommand, resolveTarget } from "./everything.ts";

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

// 119 workspaces share 37 cwds on this box, so a host lists one store once per
// workspace. One store folder is one board: duplicates must fold, not multiply.
test("duplicate listings of one store folder fold to one board", () => {
  const folded = foldBoards({
    boards: [
      { cwd: "/repo/a", directory: "/state/a", title: "Run one", summary: { open: 1 } },
      { cwd: "/repo/a", directory: "/state/a", title: "Run two", summary: { open: 2 } },
    ],
  } as never);
  assert.equal(Object.keys(folded).length, 1);
  assert.deepEqual(folded["/state/a"], { open: 1 });
});

// The strip sends the short label the panel renders (KLV, DGX, G5); the host map
// is keyed by machine name (korolev, dgx-spark, pcg5). Exact-match lookup made
// every non-local row read "no boards" while the host answered fine by hand.
test("the panel's label finds the machine it names", () => {
  // The panel's labels are Paseo host names (KLV, G5), which are not derived from
  // the machine name, so the map carries them as aliases beside the real name.
  const map = { korolev: "docker:korolev", KLV: "docker:korolev", pcg5: "des@pcg5", G5: "des@pcg5" };
  assert.deepEqual(resolveTarget(map, "KLV"), ["docker:korolev"]);
  assert.deepEqual(resolveTarget(map, "G5"), ["des@pcg5"]);
  assert.deepEqual(resolveTarget(map, "korolev"), ["docker:korolev"]);
  assert.deepEqual(resolveTarget(map, "UNKNOWN"), ["UNKNOWN"]);
});
