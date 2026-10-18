// The clock context (o47.4): the tick stays in DashboardView, the leaves read
// it through context, and nothing between them re-renders on the tick. Pure
// pins, run through the client harness with react-native stubbed — the
// hookful parts are typed by typecheck and proven by the panel's perf log.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientHarness } from "../../test-support/client-harness.mjs";
import { quietSince } from "../shared/format.ts";

const directory = new URL("../", import.meta.url).pathname;

// react-native stubs, as in panel.test.ts: identity components, so the
// modules load and their element trees stay inspectable.
const rn = {
  View: (props: Record<string, unknown>) => null,
  Text: (props: Record<string, unknown>) => null,
  Pressable: (props: Record<string, unknown>) => null,
  ScrollView: (props: Record<string, unknown>) => null,
  ActivityIndicator: (props: Record<string, unknown>) => null,
  Platform: { OS: "web", select: (options: Record<string, unknown>) => options.web },
  Animated: {
    View: (props: Record<string, unknown>) => null,
    Value: class {
      value: number;
      constructor(value: number) { this.value = value; }
      interpolate() { return this.value; }
    },
    loop: () => ({ start() {}, stop() {} }),
    sequence: () => ({}),
    timing: () => ({}),
  },
} as Record<string, unknown>;

function load(path: string) {
  return clientHarness(directory, { "react-native": rn, "@getpaseo/plugin/client/react-native": { Icon: (props: Record<string, unknown>) => null } }).load(path);
}

// A component outside a provider — a dialog rendered by the host, a leaf the
// provider does not cover — must never read a frozen time.
test("outside a provider the clock reads fresh; inside, the provider's value wins", () => {
  const { readNow, NowProvider } = load("client/now.tsx") as {
    readNow: (now: number | null) => number;
    NowProvider: (props: { now: number; children: unknown }) => unknown;
  };
  const before = Date.now();
  assert.ok(readNow(null) >= before, "a null context reads the real clock, never a stale value");
  assert.equal(readNow(1_234_567), 1_234_567, "the provider's clock wins");
  // The provider carries the clock on the context, and the tree passes
  // through untouched — wrapping changes nothing about what renders.
  const child = { marker: "tree" };
  const element = NowProvider({ now: 1_234_567, children: child }) as { props: { value: number; children: unknown } };
  assert.equal(element.props.value, 1_234_567, "the clock rides the context value");
  assert.equal(element.props.children, child, "the tree passes through untouched");
});

// The quiet line moves from a prop computation inside TicketList to a leaf
// that reads the clock itself. What it says must not change by one word.
test("the quiet line says what it always said, from the clock it reads", () => {
  const updatedAt = "2026-10-18T10:00:00.000Z";
  assert.equal(quietSince(updatedAt, Date.parse(updatedAt) + 23 * 60_000), "No update for 23 min");
  assert.equal(quietSince(updatedAt, Date.parse(updatedAt) + 90 * 60_000), "No update for 1 h 30 min");
  assert.equal(quietSince(updatedAt, Date.parse(updatedAt)), "No update for <1 min", "a just-touched board never reads as 0 min");
  assert.equal(quietSince(null, Date.now()), undefined, "no timestamp, no quiet line");
});

// React.memo is the whole skip: with stable props an unchanged dashboard
// object bails DashboardView's tick render before the list body runs.
test("the objectives list is memoised, so an unchanged dashboard skips the tick", () => {
  const { TicketList } = load("client/panel.tsx") as { TicketList: { $$typeof?: symbol } };
  assert.equal(TicketList.$$typeof, Symbol.for("react.memo"), "React.memo on the list, not a plain function");
});

test("the tick keeps its 15 s cadence", () => {
  const { NOW_TICK_MS } = load("client/panel.tsx") as { NOW_TICK_MS: number };
  assert.equal(NOW_TICK_MS, 15_000);
});
