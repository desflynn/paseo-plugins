// The board panel's own background (o25): Paseo's sidebar tone, which the plugin
// theme does not hand over, derived from surface0. The sidebar is a warmer step
// than a pure ratio, so the derived tone is checked to within one step per channel.
// Pure, so it runs without the app.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sidebarTone } from "./surfaces.ts";

const colors = (surface0: string) => ({ surface0 }) as Parameters<typeof sidebarTone>[0];
const channels = (hex: string) => hex.match(/[0-9a-f]{2}/gi)!.map((d) => parseInt(d, 16));

function assertNear(surface0: string, sidebar: string) {
  const got = channels(sidebarTone(colors(surface0)));
  channels(sidebar).forEach((want, i) => assert.ok(Math.abs(got[i] - want) <= 1, `${surface0}: channel ${i} is ${got[i]}, sidebar has ${want}`));
}

test("the dark Paseo theme lands within one step per channel of its sidebar tone", () => {
  assertNear("#1f1f1e", "#1a1918");
});

test("other dark themes land within one step per channel of their sidebar tone", () => {
  assertNear("#181B1A", "#141716");
  assertNear("#282c34", "#21252d");
  assertNear("#18181b", "#131316");
});

test("a light theme steps down only slightly", () => {
  assertNear("#ffffff", "#f4f4f5");
});

test("pure black stays black and an unreadable color comes back unchanged", () => {
  assert.equal(sidebarTone(colors("#000000")), "#000000");
  assert.equal(sidebarTone(colors("hsl(0 0% 12%)")), "hsl(0 0% 12%)");
});
