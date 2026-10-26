# The Everything tab (owner ask, 25 Oct)

Bead: `paseo-plugins-6uz`. Objective: `o1` on the run "Progress across machines".

## Work log

- **25 Oct, step 2 done — offline cache and fan-out are in and green.**
  `server/hosts.ts`: `shortLabel()` (KOR, DGX, IDE from the Paseo host label), and a snapshot
  cache where a failed read falls back to the last good board marked `stale`, and an empty
  read never overwrites a good cache. `server/collect.ts`: `collectHosts(targets, read,
  cacheDir, now)` runs every host through `Promise.allSettled`, so one dead box cannot blank
  the page; the ssh call is injected as `HostReader` so the logic is testable without a
  network. `server/hosts.test.ts` + `server/collect.test.ts`: **12 tests, all green.**
  Next: the aggregate RPC contract, then the ssh adapter, then the client default.
- **25 Oct, step 3 done — contract, ssh reader and handler are in.**
  `shared/rpc.ts`: `progress.overview.all` (input: the hosts the client knows; output: one
  snapshot per host with `at` and `stale`). `server/everything.ts`: `readHostBoards` runs
  `ssh des@<label> paseo-progress show --all --json` with a 15s timeout and folds it through
  `summariseBoard`, and `handleGetAllHostsOverview` wires it into `collectHosts` with a cache
  at `~/.dci/progress-cache`. Registered in `index.server.ts` beside `getOverview`.
  **State: `tsc --noEmit` clean, full suite 391 pass, 0 fail.**
  CLIENT LANDED: an Everything strip on the Progress page (`useHosts()` + the new RPC),
  one row per machine with its short label, board count and a `cached` marker, shown
  above the boards and hidden when fewer than two hosts are configured.
  Next: the same machine tag on board cards and feed rows. Everything entry selected by default, machine tag (short label
  plus a computer glyph) on the board cards and the feed rows, single-host picks unchanged.

- **25 Oct, step 1 done — feasibility settled, and it is not the easy path.**
  The SDK does expose other hosts: `useHosts(): PluginHostSummary[]`
  (`{serverId, label, status}`) and `getPaseoClient(serverId)` to borrow an online host's
  `PaseoApi`. But `PaseoApi` carries **no plugin-RPC invoke**: it offers workspaces, agents,
  config, timeline. The progress board itself comes from this plugin's own server RPC
  (`getOverview`) on the host the panel is attached to, and `callPluginRpc(contract,
  invoke, input)` takes an `invoke` supplied by that host's context — there is no
  serverId parameter.
  **Consequence:** from host A's client we can read host B's workspace and agent lists,
  but not host B's progress boards. The aggregation Des asked for cannot be assembled
  from the Paseo client API alone.
  Three routes exist; the owner picks (see "Open decision" below).

## Decision (25 Oct, Des)

**A, plus a cache for offline hosts.** The collector reads each host live and falls back to the
last good snapshot when a box is offline, marked stale. Route B (a periodically combined
file) is filed as **o1.1, P3, 120 min** — a good long-term pattern, not the first build.

## Next steps, with the seams already found

1. **Contract** — `shared/rpc.ts:47` defines `getOverview` with `defineRpc`. Add a sibling
   contract for the aggregate: per host `{serverId, label, status, boards, at, stale}`.
2. **Handler** — `index.server.ts:13` registers handlers with `server.handle(...)`. Add the
   aggregate handler there: for each configured host run
   `paseo-progress show --all --json` over ssh with a hard timeout, parse, and on failure
   serve the cached snapshot for that host with `stale: true`.
3. **Cache** — one JSON file per host in the plugin's server-side data directory, written
   after every successful read, stamped with `at`. Never overwrite a good snapshot with a
   failure.
4. **Client** — an in-panel **Everything** entry that is selected by default; picking a
   single host keeps today's behaviour. Machine tag = short label plus a computer glyph on
   the board card header and on each feed row.
5. **Tests** — merge and cache-vs-live fallback as pure functions first (no ssh), then a
   fake runner for the ssh layer. Offline must never blank the page.

## What Des asked for

The Progress dashboard already has a dropdown that picks a connected Paseo host and loads
that host's dashboard. He wants the same page aggregated across **all** connected hosts,
with **Everything as the default**, and hosts still pickable when he wants one box.

The same ask carries a second half: feed rows should say which machine an objective was
worked on — the machine's short name plus a computer icon.

## What already exists (do not rebuild)

- `client/overview.tsx` is the page. `loadGroups()` fetches one host:
  `fetchOverview({workspaces})`, then `groupOverview(workspaces, boards, agents)`.
- `shared/overview.ts` holds `groupOverview()`, `pageFeed()` (which already merges every
  group's feed into live, changes and finished), `summariseBoard()` and `splitGroup()`.
- `client/overview-card.tsx` holds `BoardCard`, `ChatsCard` and `AgentRow`; each takes
  `hostId` and uses it as `serverId` for navigation.

The merge primitives exist. What is missing is a fan-out over hosts, a machine tag, and
the default.

## Plan, smallest first

1. **Enumerate hosts.** The dropdown lives outside `overview.tsx`; `hostId` arrives as a
   prop. Confirm one call lists the connected hosts and their labels.
2. **Fan out.** `loadGroups` gains an all-hosts mode: run the existing per-host fetch for
   every host, tag each returned workspace with `{hostId, hostLabel, short}`, concatenate,
   then call `groupOverview` **once** over the union so one section holds everything.
3. **Tag the feed.** `pageFeed()` rows already carry `board` and `workspaceId`. Add
   `host` (short label) so rendering needs no second lookup.
4. **Render the machine.** In the feed row, show the short name (`MS`, `KOR`, `DGX`,
   `IDP`) plus a computer glyph, muted, before the board name. Same tag on the board card
   header.
5. **Default to Everything.** The picker's initial value becomes the all-hosts sentinel.
   Picking one host keeps today's behaviour exactly.

## Traps

- One host offline must not blank the page. Use `Promise.allSettled`; that host's rows
  read as unknown and the rest still render.
- Hosts are keyed by `serverId`. Two hosts can hold identically named workspaces, so the
  union must never key by workspace name.
- Do not change the record schema for this. The machine comes from the host, not the event.
- `pageFeed` already merges groups. Do not write a second merger.
