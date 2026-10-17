# The Progress fleet dashboard — a primer

This is the Progress page of the `progress` plugin: the one screen that shows every board, every agent and every full-auto state across the whole fleet on this machine. It is written for someone who has used the per-workspace Progress panel and now wants the model of the fleet view — what it reads, how it decides what to show, and where its sight ends. Every claim here comes from the plugin's source; where the source could not confirm something, the text says so.

**In one minute.** The Progress page is the fleet view. Every three seconds it lists workspaces and agents from the Paseo SDK and folds each workspace's board file through one plugin call. It groups repos into Top (BRO-labelled, all idle), Active, Idle and Quiet, and draws one card per board with a five-state mode strip. It sees only this host, only what agents record in their board files, and it cannot restore archived workspaces. Paseo owns the daemon, the SDK and the labels; DCI owns full auto (conn state, wakes). The long form follows; skim the headings if you are short of time.

## Two surfaces, one plugin

The plugin gives you two different views, and people mix them up.

The **Progress page** is the fleet view. It is the flag-icon "Progress" row in the Paseo sidebar (`client/overview.tsx`, registered in `index.client.tsx`). Clicking it opens a full screen, not a panel: every project Paseo can see, grouped into sections, one card per board. The layout rules live in `shared/overview.ts` (pure, tested) and the cards in `client/overview-card.tsx`.

The **Progress panel** is the per-workspace view. It is the "Progress" panel in Explorer, beside the agent chat (ListChecks icon), opened from Command Center with "Open Progress" (`client/panel.tsx`). It shows one workspace's board in full detail — objectives, questions, deliverables, the Beads tab. A small ticker icon in its header spins while work is active, warns amber only when in-progress work has stalled, and sits as a grey dot when idle. A pill above the message box counts open questions and stuck work.

The page summarizes; the panel details. The page's card for a board is a fold of the same board file the panel shows in full.

## Where the picture comes from

Every three seconds, the page asks two sources and merges them.

First, the **Paseo SDK** (through `usePaseo`): it lists all workspaces and all live agents, paging through until it has every one. Workspace labels ride along on the workspace records — the "BRO" label that drives the Top section is a label Paseo holds, not something this plugin sets. Archived agents are excluded from the live list and read separately, only on demand (below).

Second, the **board files**. Each workspace points at a directory; the plugin server folds that checkout's progress file — `progress.jsonl`, an append-only event log living under `~/.local/state/paseo-progress/` on the daemon host, outside the repo — into a dashboard, and `summariseBoard` (`shared/overview.ts`) compresses that dashboard into the small `BoardSummary` the card needs: counts, priorities, the item being worked, the open list, conn and hold state. One RPC, `progress.overview` (`shared/rpc.ts`, handled in `server/dashboard.ts`), folds every listed workspace in one call. A workspace whose file cannot be read folds to null and never fails the rest.

There is also a registry resolver (`server/workspace.ts`, `server/registry.ts`) that reads the Paseo home's `agents/` folder on disk to attribute events to workspaces during folding. It is server-side bookkeeping, not a page input.

Two writes leave the page. **Archive** buttons call the SDK's own archive. The **mode selector** calls `progress.mode.set`: a hold or spec is written straight to the board file as events (the same ones `paseo-progress hold set` writes), but a change to full auto is not written anywhere — it is sent to the board's owner seat as a prompt (`/fullauto …`), because only the seat itself owns its conn: it renames itself and files its own wakes. A failed ping never undoes the board change.

## How fresh, and when

`POLL_MS = 3000` in `client/dashboard-query.ts` is the drumbeat for both surfaces. The page re-lists workspaces and agents and re-folds every board every three seconds (react-query, `staleTime` three seconds). The panel polls on the same rhythm and sends the version it already holds; an unchanged reply keeps the cached object, so nothing re-renders. A hidden panel stops polling entirely — a background window costs nothing.

On demand only: the archived-agents list (loaded when you open the modal, cached fifteen seconds), the Beads tab (every ten seconds, only while its tab is showing), and the pills (five seconds, with quiet workspaces checked on a slower loop).

One consequence of the model: nothing on this page is live telemetry. A board changes only when an agent runs a `paseo-progress` command. A seat that works without recording reads as idle, then stale — the page faithfully reports what the board file says, not what the agent is doing.

## What the page shows

Workspaces group by project into **repos**. A repo with boards and no live work anywhere still shows; a workspace with neither a board nor a live agent is dropped entirely.

Repos fall into four **sections**. **Top** holds repos whose workspaces carry the BRO label while *all* their BRO boards are idle — the moment one is not, the repo jumps to the front of Active. **Active** means some board has in-progress work. **Idle** means open P0–P2 work waits, nothing running, nothing paused. **Quiet** is everything else — paused, stuck, or nothing to pick up — and starts folded. Within a section, repos rank by their best board's seat: BRO first, then a workspace named like a Head Guy, then Ninja, then the rest alphabetically; a repo with only unboarded agents ranks last. The same seat order sorts boards inside a repo.

Each repo renders as a **block**: a header (name, path, board and agent counts, the view-archived icon) and its cards packed into rows. A repo takes as many columns as it has cards (three at wide widths, two from 620px, one when narrow), repos fill rows in order — 1-1-1, 1-2, 2-1, never 1-3 — and a repo that does not fill its row ends in a thick grey rule so you can see where it stops.

A **board card** carries, top to bottom: the conn sign (`♾️(budget)`) when full auto is on, the workspace name stripped of its auto icons, a hold chip when held, and right-aligned status dots — Idle, Active N, Stale N, Stuck N. Stuck counts only P0–P2 items on boards with work moving or full auto on. Below that: a minutes-based progress bar (stale tints the working part amber, stuck tints the remaining part red; no estimates, no bar), a percent-and-counts line, priority chips (P0/P1/P2 counts, `+N lower`), the item being worked right now, and the Open list — in-progress rows first, ∞ marks on the P0–P2 rows full auto may pull, children nested with a `>` marker, and parked P3/P4 rows folded behind a `+N more open` toggle. A very faint tint over the whole card betrays the mode: yellow hold, lilac spec, green full auto, light green clear, none for manual.

The **mode strip** at the card's foot is five icon buttons — Manual, Hold, Spec, Clear the board, Full auto (the words sit in each button's tooltip). Manual, Hold and Spec ask first, in a modal; Clear and Full auto go straight through but are dimmed when no live owner seat exists, because they work by telling that seat to run the command. Anything that pauses or closes asks first, in a modal that says what will happen.

Two more surfaces: an **"Agents without a board"** card gathers the repo's workspaces that have live agents but no board ("chats"; the scheduler's own "Nightly Automations" workspace is excluded), taking a full row when it would otherwise sit alone. And the **archived agents** modal, from the repo header, lists that repo's archived agents — matched by the folder they worked in, newest first — and opens one to chat. Restore does not exist; the SDK has no such call.

## What the page cannot see

- **Workspaces with no board and no live agent.** Dropped in the fold. A workspace needs at least one `paseo-progress start` ever run, or a live agent, to appear.
- **Archived workspaces.** Archiving from the card removes the workspace from the dashboard. Whether the SDK's workspace list could ever return archived workspaces is Paseo's behaviour, not this plugin's — NOT CONFIRMED here; the page just renders what the list gives it.
- **Other machines.** Everything — SDK lists, board files, registry — comes from the one daemon host the page is opened on. There is no federation across daemons or hosts; anything beyond this host's PaseoApi is out of reach.
- **Anything outside the Paseo SDK.** The plugin sees only what the SDK exposes: workspaces, agents, labels, message sends. No agent restore exists there. GitHub issues are a placeholder tab in the panel only; Beads likewise live in the per-workspace panel, not on this page.
- **Work the agents do not record.** The page is a mirror of the board files. Silence on the board reads as idle, then stale, whatever the agent is truly doing.

Ownership, for borrowing patterns: the daemon, `PaseoApi`, the agent registry and workspace labels are **owned by Paseo**. The full-auto machinery — conn state, wakes, the ♾️ renaming — is **owned by DCI**: the seat writes conn onto its board with `paseo-progress conn set`, and this plugin only stores, folds and displays it, and forwards mode changes as prompts.

## Reference

- **Register:** `index.client.tsx` — sidebar item, screen, panel, command, pills.
- **Page:** `client/overview.tsx` (screen, data loading, sections, repo blocks); `client/overview-card.tsx` (board card, chats card, mode selector, confirms); rules pure and tested in `shared/overview.ts`; mode logic in `shared/modes.ts`.
- **Panel:** `client/panel.tsx` (per-workspace detail); poll settings in `client/dashboard-query.ts` (`POLL_MS = 3000`, hidden stops polling, version-based `unchanged`).
- **RPCs:** `shared/rpc.ts`, handlers in `server/dashboard.ts` — `progress.overview` (fold all boards), `progress.mode.set` (hold/spec write; full auto pings the owner seat), `progress.get` (panel).
- **Storage:** `server/store.ts` — boards under `~/.local/state/paseo-progress/<repo>-<hash>` on the daemon host; run history to `history/` in the repo by default. Registry reads: `server/workspace.ts`, `server/registry.ts`.
- **Sections:** Top (BRO, all idle) · Active · Idle (pullable P0–P2, nothing running) · Quiet (folded). Seat order: BRO → Head Guy → Ninja → rest; repos rank by best board.
- **Modes:** Manual · Hold · Spec · Clear the board · Full auto; a hold wins the display over a conn that stays running underneath.
