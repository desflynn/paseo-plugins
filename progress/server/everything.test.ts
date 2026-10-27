import assert from "node:assert/strict";
import { test } from "node:test";
import { boardsEndpoint, foldBoards, hostCommand, makeHostReader, resolveTarget } from "./everything.ts";

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

// The harness answers on a fixed port with a token. A docker target is reached
// through the docker socket, not the network, so it has no endpoint.
test("an ssh host has an endpoint and a docker host does not", () => {
  assert.equal(boardsEndpoint("des@dgx-spark", 8770), "http://dgx-spark:8770");
  assert.equal(boardsEndpoint("des@100.98.165.77", 8770), "http://100.98.165.77:8770");
  assert.equal(boardsEndpoint("dgx-spark", 8770), "http://dgx-spark:8770");
  assert.equal(boardsEndpoint("docker:korolev", 8770), null);
});

const boardsJson = { boards: [{ cwd: "/repo/a", directory: "/state/a", title: "Run", summary: { open: 1 } }] };

// ssh is the part that breaks: ideaPad refuses every key, DGX has no helper, G5
// has no route. The endpoint answers or says why, so it is tried first.
test("the endpoint answers before any shell runs", async () => {
  const seen: string[] = [];
  const reader = makeHostReader({
    token: "tok",
    port: 8770,
    fetch: (async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(`${url} ${init?.headers?.["x-dci-token"]}`);
      return { ok: true, status: 200, json: async () => boardsJson };
    }) as never,
    run: async () => {
      throw new Error("the shell must not run when the endpoint answers");
    },
  });
  const boards = await reader({ label: "DGX" } as never);
  assert.deepEqual(boards["/state/a"], { open: 1 });
  assert.deepEqual(seen, ["http://dgx-spark:8770/v1/boards tok"]);
});

// An endpoint that refuses falls back to the shell path, so a box without the
// endpoint keeps working exactly as it does today.
test("a refused endpoint falls back to the shell", async () => {
  let shelled = 0;
  const reader = makeHostReader({
    token: "tok",
    port: 8770,
    fetch: (async () => ({ ok: false, status: 401, json: async () => ({ error: "token" }) })) as never,
    run: async () => {
      shelled += 1;
      return { stdout: JSON.stringify(boardsJson) };
    },
  });
  const boards = await reader({ label: "DGX" } as never);
  assert.deepEqual(boards["/state/a"], { open: 1 });
  assert.equal(shelled, 1);
});

// 200 with an empty list is the failure that cost an evening: it reads as a live
// machine with nothing on it. It must fall through, never be returned.
test("an empty 200 is a failure, not a result", async () => {
  let shelled = 0;
  const reader = makeHostReader({
    token: "tok",
    port: 8770,
    fetch: (async () => ({ ok: true, status: 200, json: async () => ({ boards: [] }) })) as never,
    run: async () => {
      shelled += 1;
      return { stdout: JSON.stringify(boardsJson) };
    },
  });
  const boards = await reader({ label: "DGX" } as never);
  assert.deepEqual(boards["/state/a"], { open: 1 });
  assert.equal(shelled, 1);
});

// No token means no authorised read, so there is nothing to try.
test("no token skips the endpoint and goes straight to the shell", async () => {
  let fetched = 0;
  const reader = makeHostReader({
    token: "",
    port: 8770,
    fetch: (async () => {
      fetched += 1;
      return { ok: true, status: 200, json: async () => boardsJson };
    }) as never,
    run: async () => ({ stdout: JSON.stringify(boardsJson) }),
  });
  await reader({ label: "DGX" } as never);
  assert.equal(fetched, 0);
});
