Progress gives each worktree a live dashboard for long agent jobs. The agent records its tickets or steps with a `paseo-progress` command, along with what's stuck, questions for you and finished work. The Progress panel in Explorer shows all of it. Needs Paseo 0.11 or later, and Node.js 22.18 or later on the computer running the Paseo daemon.

The panel shows how much of the estimated work is done, what the agent is doing right now, and where each ticket stands. A ticket turns stuck when it's blocked or runs past its estimate without an update. Press a ticket to see its timeline, activity, questions and deliverables. Images and text files the agent records open in a preview inside Paseo. Any other file opens in an app on the computer running the Paseo daemon, and so does a previewed file when you press Open. That's true from your phone too. The app opens on that computer, not on the phone.

When the agent needs a decision, it asks a numbered question with lettered options and says which one it recommends. A pill above the message box counts open questions and stuck work. Each option has a Copy button. Paste the answer into the chat and the agent records it.

Nothing updates unless the agent runs the command, so agents need the plugin's skill. The panel has two setup buttons, and each one shows where it will write before you press it:

- Install command writes `~/.local/bin/paseo-progress` on the daemon host.
- Install skill links the plugin's `paseo-progress` skill into `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills`. New agent sessions pick it up.

Both work from files inside the plugin and download nothing. Neither one replaces a file you made.

## Where data lives

Each worktree's board lives under `~/.local/state/paseo-progress/` on the daemon host, outside the repo. Run history saves to `history/` in the repo by default, so the run survives in the worktree's git history. The exception is a public origin: if the repo's remote is on github.com, gitlab.com or bitbucket.org, saving stays off until you choose a folder. Choosing a folder with Save to repo overrides that public-origin rule and saves there. Stop saving is remembered as an empty `paseo-progress.saveRuns` value in the repo's local git config, and it stays off. The storage rule itself is [server/store.ts](server/store.ts) (`historyFolder`, `DEFAULT_HISTORY_FOLDER`, `PUBLIC_HOSTS`, `SAVE_RUNS_KEY`). There's no view across worktrees by default, and a deleted worktree's folder stays behind until you remove it.

This page describes the plugin as it sits in the working tree on this branch. Three features — Hold (o34), the Progress page (o36) and default run saving (o22) — are in the working tree at the time of writing, not yet commits.

## How the board works

A board is one persistent object per workspace, built from an append-only event log. The server folds the events into a dashboard — tickets, activity, questions, stuck items, conn and hold state — in [shared/dashboard.ts](shared/dashboard.ts). Unstamped events inherit the workspace of their ticket's `add` event, so a correction filed from elsewhere still folds into the ticket's home board.

Objectives sort in three groups, top to bottom: in progress, then open, then finished. Finished sinks to the bottom, newest first, and ignores priority. Inside the live groups the order is priority band (P0 is most urgent, P4 least, an unset priority reads P5 on screen via `displayPriority` — the stored value stays unset), then the objective's o-number. Children nest under their parents by the same rule. A priority pill sits on each row's title line in [client/unified-list.tsx](client/unified-list.tsx).

The board-name line carries a right-aligned status indicator (`StatusIndicator` in [client/panel.tsx](client/panel.tsx)): a filled dot per status, with Idle's dot hollow — Idle, Active N, Stale N, Stuck N. Stale means in-progress work has gone quiet; an idle board is never stale. Next to it, the ticker icon spins while work is active, warns only when in-progress work is stalled, and sits as a grey dot when idle.

## The Progress page

The sidebar's Progress row — the Lucide Flag icon and the "Progress" label — opens a screen over every project, board, agent and full-auto state on the daemon host. It is registered in [index.client.tsx](index.client.tsx) with `client.addSidebarHeaderItem`, mounting `ProgressSidebarItem` / `ProgressOverviewScreen` from [client/overview.tsx](client/overview.tsx), keyed by `PROGRESS_SCREEN_ID`. The sidebar item renders the Lucide Flag icon and the "Progress" label. The screen reads the `progress.overview` RPC ([shared/rpc.ts](shared/rpc.ts)), whose payload type `BoardSummary` is built in [shared/overview.ts](shared/overview.ts).

## Conn: full auto

`conn set` stores the conn ("full auto") state a driving engine writes and rewrites on every nudge:

```
paseo-progress conn set --budget 5 --mode live --next-nudge-at 2026-10-15T12:00:00Z
paseo-progress conn clear
```

`--clear` marks a full-auto clear: work the board down, then turn the conn off at idle — the close that leaves nothing to work turns it off on its own, as `conn clear` does. A rewrite without `--clear` drops the mark. `--workspace <id>` targets another seat's board from outside it. Mode `live` means work is outstanding; `keepalive` means only the cache keep-alive is pending. The conn state is event-sourced board state: `conn.set` and `conn.clear` events fold into `dashboard.conn` in [shared/dashboard.ts](shared/dashboard.ts), and it is left out of `show --json` entirely while the conn is off. While the conn is on, the panel header and `show` display it, and rows full auto would pull carry an infinity mark.

## Hold

Hold (o34, in the working tree) pauses work on a board without closing it:

```
paseo-progress hold set --kind closed --note "waiting on the owner"
paseo-progress hold clear
```

`--kind` is `closed` (closed to work) or `speccing` (the owner is here speccing); `--note` is optional. The `hold.set` and `hold.clear` events ([shared/events.ts](shared/events.ts), `HOLD_KINDS`) fold into `dashboard.hold` like conn state. Items can still be added while held, but no work starts: claiming and moving an objective into progress are refused with a message that names `hold clear` as the lift. `show --ready` comes back empty, the infinity marks stay on P0 to P2 rows (a hold pauses the pulling, not the property; `isAutoPullable` in [shared/dashboard.ts](shared/dashboard.ts) ignores the hold), and the hold shows in the panel header and on the Progress page (`holdLabel`, `holdHover`). Text `show` prints a `Hold:` line last, with the kind, the since time and any note.

## Showing and cutting the board

`show` prints what the panel shows; `show --json` is machine-readable and carries the board indicator. The objective cut takes `--status <open,in_progress,blocked,closed>`, `--priority <0-4, none, a list or a range like 0-2>`, and `--ready` (open or in progress, P0 to P2 — what a seat may pull; P3, P4 and no priority are owner-held). `--mine` narrows to your work, `--all` folds in every workspace, and `--workspace <id>` reads another seat's board. `ticket show <id>` prints one objective, `--json` for machine-readable output. All commands are defined in [server/cli.ts](server/cli.ts), which runs from source — there is no build step.

## Board lifecycle

`rename "<title>"` renames the current board (and its subtitle), so a long-lived workspace keeps one board per theme instead of starting over. It works in workspaces whose slice holds no run of their own, too — such as a seat folded into a shared board. `ticket add --under <id>` nests a new objective as the next child at any depth (`o1.1`, `o1.1.2`); `ticket update --under <id>` re-nests an existing one. `start` refuses to retire an existing board — work the current one with `show` and `rename` it when the theme changes — and `--replace` is the deliberate override, which retires the board and reports how many open objectives leave the dashboard. `ticket move` and `claim` reallocate an objective to another workspace, children following the parent, as appended events.

## Beads and promotion

Beads are read through `bd` and mirrored into the Beads tab, grouped into families with `nestBeads` in [shared/dashboard.ts](shared/dashboard.ts). Promoting a bead (`promoteBead` in [server/beads.ts](server/beads.ts), from the button under the bead's details) adds an objective carrying the bead's title and ref, takes the bead's priority with it, marks the bead as promoted, and lands on the panel's workspace; closing the objective cascades to the backing bead.

## The perf watch

The panel watches its own performance by default: render reasons, render-to-commit timing for the freeze log, and 30-second render-count summaries, written to a local perf log. `localStorage "pp-perf" = "0"` stops the watch's timers; `"1"` or no value leaves it running ([client/perf.ts](client/perf.ts)). A hidden panel schedules nothing — cadences pause while the panel's document is hidden, so a background window stops eating CPU. The Beads tab fast-polls only while its tab is the one showing.

## Module map

- [server/cli.ts](server/cli.ts) — every `paseo-progress` command, run from source.
- [server/store.ts](server/store.ts) — where board and run-history files live, and the saving rule.
- [server/beads.ts](server/beads.ts) — the `bd` bridge: reading, updating and promoting beads.
- [shared/dashboard.ts](shared/dashboard.ts) — the event fold, ordering, hold and conn state, display helpers.
- [shared/events.ts](shared/events.ts) — the event schema, including `hold.set` / `hold.clear` and the conn events.
- [shared/rpc.ts](shared/rpc.ts) and [shared/overview.ts](shared/overview.ts) — the RPC surface and the `progress.overview` payload.
- [client/panel.tsx](client/panel.tsx), [client/unified-list.tsx](client/unified-list.tsx), [client/overview.tsx](client/overview.tsx), [client/perf.ts](client/perf.ts) — the panel UI, the objective list, the Progress page, the perf watch.

For the agent-facing procedure, see the plugin's [paseo-progress skill](skills/paseo-progress/SKILL.md); for features in plain language, see [README.md](README.md).
