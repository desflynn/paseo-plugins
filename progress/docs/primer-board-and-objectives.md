# The board and its objectives: a primer

You have used the Progress panel; this is the model underneath, written from the code. Every claim traces to the plugin's source.

**In one minute.** A board is one append-only file of JSON lines; the panel and the Progress page are folds of it, and nothing else holds state. The file is one per checkout (a folder keyed by the worktree's path), sliced per workspace when read. "Objective" and "ticket" are the same object (`o1`, `o1.1`, ids never reused). Only P0, P1 and P2 are pulled to run under full auto; P3, P4 and none are owner-held. The `history/` copies in the repo are mirrors, not the state. The edges that bite: two seats on one checkout share the file, a plain-terminal command can land on another seat's board, and the plugin only knows what agents record. The long form follows; skim the headings if you are short of time.

## 1. The words: run, board, bag, objective, ticket

A **run** is one working cycle: opened by `paseo-progress start`, closed by `finish`. The fold shows only the latest run's events. Earlier runs stay in the file as history.

A **board** is the same thing seen as persistent — `server/cli.ts` says it in `start`'s own summary: "A board is one persistent object per workspace." Two words, one thing: the board is the object attached to the workspace, the run the current cycle on it. `start` only works where no board exists, `rename` retitles it when the theme changes, and `start --replace` is the deliberate override that retires it.

An **objective** and a **ticket** are the same object, and the code says so: the events are `ticket.add` and the CLI verbs `ticket claim` and `ticket done`, while "Objective" is the default item label the panel and `show` use (`start --item-label` renames it). Ticket is the machine word; objective the human one.

A **bag** is not a plugin word, and not a word from Des's fleet either: it is slang from Joey's home-lab deep dive for the per-worktree event store and its key. In the plugin's own terms, a bag is the per-checkout folder of section 2: `<basename>-<sha1 of the real git-root path, first 8 hex>/progress.jsonl`. Two Paseo workspaces on one checkout share the same bag. One nuance: they share the file, but each folds only its own slice of it, so each still has its own run and its own board; "one bag, one run, one flat list" holds only while a single workspace uses the checkout.

## 2. The event-sourced file: where state actually lives

The board is event-sourced: every change is one JSON line appended to `progress.jsonl`, never rewritten, and the panel shows a fold of those lines (`reduceProgress` in `shared/dashboard.ts`). The file is the only real state; the dashboard a view.

The file lives outside the repo, one folder per worktree under `~/.local/state/paseo-progress/` on the daemon host: `<basename>-<8 hex>/progress.jsonl`, keyed by the worktree's real path — a SHA-1's first 8 hex (`outsideDirectory` in `server/store.ts`). From any checkout, a command walks up to the nearest `.git` entry to find it (`findRoot` in `server/paths.ts`) — subfolders, plain checkouts and linked worktrees all work. That is the worktree keying.

It is **one file per checkout, not one per workspace**: several Paseo workspaces can share a checkout, all appending to the same file, each event carrying optional `ws` (workspace id) and `by` (agent id) stamps. The fold slices per workspace at read time (`scopeEvents` in `shared/dashboard.ts`): this workspace's board is its slice; `show --all` and the GIT card fold every workspace's run together. Workspace keying sits inside the file, not beside it. A lock file (`progress.jsonl.lock`) serialises writes, so two commands never append at once or mint the same id.

The `saveRuns` setting only mirrors. It lives in the repo's local git config (`paseo-progress.saveRuns`). After each change, `saveRunCopy` in `server/store.ts` rewrites that run's slice — that workspace's events from its `run.start` on — as one file under `history/` in the repo, named at the start by timestamp and title slug and never renamed. Saving is on by default, off for a public origin (github.com, gitlab.com, bitbucket.org) unless you pick a folder; an empty setting means stopped for good. The repo copies are mirrors: delete the working folder and the board is gone; only `history/` survives in git.

## 3. Ids and events

Top-level ids are minted by `nextObjectiveId` in `shared/dashboard.ts`: `o` plus one past the highest number ever added in the run — legacy `T01` ids count as o1, adds later moved away still count, and a spent number is never reused (`ticket remove` does not free it).

Child ids come from `nextChildId` in `server/cli.ts`: the parent's path plus the next sibling position — `o1.1`, `o1.1.2`, any depth. The tree is the `under` field, not the id. `ticket update --under o2` re-nests an existing objective and its children follow; the id never changes. A move under its own descendant is refused.

Question ids (Q1, Q2, …) stay unique across runs, so an answer never lands on an old question; deliverable (D), activity (A) and stuck (S) ids restart each run.

The event types in `shared/events.ts`:

- `run.start` — opens a run (title, optional subtitle and item label); the fold shows the latest.
- `run.finish` — closes the run with an outcome; it takes no more work.
- `run.rename` — retitles the run in place; a correction, not a new run.
- `ticket.add` — adds an objective: estimate, optional status, priority, waits-for, source, refs, `under`.
- `ticket.update` — changes any field of a ticket: status, close reason, priority, stage, note, waits-for, source, refs, `under`.
- `ticket.remove` — takes a ticket off the dashboard; its number stays spent.
- `ticket.move` — reallocation: from here on the ticket renders on the `to` workspace only; appended, never a rewrite; children follow.
- `stuck.set` — flags a blocker that is not a ticket status, optionally on a ticket.
- `stuck.clear` — clears a flagged blocker.
- `question.ask` — the numbered question, with lettered options and the agent's recommendation.
- `question.answer` — records the user's choice, optionally quoting their words.
- `question.update` — adds detail to an open question; its reference stays.
- `question.remove` — withdraws a question; its reference is not reused.
- `deliverable.add` — records something reviewable: a path or URL, optionally on a ticket, with a kind.
- `deliverable.remove` — removes a deliverable.
- `activity.add` — logs a one-line note, optionally on a ticket.
- `activity.update` — rewords an activity note.
- `activity.remove` — removes an activity note.
- `ticker.set` — one line at the top: what the agent is doing right now.
- `ticker.clear` — hides the ticker line.
- `conn.set` — stores the full-auto state the engine owns (budget, mode, next nudge); rewritten every nudge.
- `conn.clear` — turns the stored conn state off.
- `hold.set` — the board-wide hold, kind `closed` or `speccing`, optional note.
- `hold.clear` — lifts the hold.

## 4. What you see, and the rule behind it

**Order and priority.** The board sorts in three groups: in progress, then the other open ones, then finished (newest close first, ignoring priority). Inside the live groups, priority band first — P0 down to P4, unset reading as P5 on screen (`displayPriority`; the stored value stays unset, never mistakable for the pull band) — then o-number; children order the same way among siblings. A parent with an in-progress descendant counts as in progress.

**The pull band.** An open or in-progress objective at P0–P2 is what full auto may pull (`READY_TO_PULL`); the panel marks those rows ♾️ (`isAutoPullable`) whether or not conn is on or the board is held — a hold pauses the pulling, not the property. P3, P4 and no priority are owner-held. New rule in `ticket add`: a child added with `--under` and no `--priority` takes its parent's priority when that is P0–P2; an explicit `--priority` always wins, and the output says when a priority was inherited.

**Stage, waits, deliverables, questions.** A stage is the step inside a ticket (`--stage`, like Build, Fixes), timed from the call and shown on the working row. `--waits-for o3` is the order of work, not a problem: the row shows as waiting until that ticket settles, never blocked. A deliverable is something you can review — a worktree-relative path or http(s) link, kind guessed when not given — newest first, previewing inside Paseo. A question is numbered, with lettered options and the agent's recommendation; nothing the answer affects is built first.

**Stuck, indicator, ticker.** Three things count as stuck: a `blocked` status waiting on nothing in the run; a working ticket past its estimate with no status, stage, note or tagged-activity update since; and manual `stuck set` flags. A parent never renders stuck while any descendant is live; liveness rolls up and the parent shows as running. The board-name indicator (Idle, Active N, Stale N, Stuck N) counts stuck only for P0–P2 objectives, and only on a board with work in progress or a conn on (`boardStatuses`; the owner's ruling is quoted in the code). Stale means fifteen minutes with no update while tickets remain, never on a finished board. The ticker icon follows the same statuses: spinner while active, amber only when in-progress work has stalled, grey dot when idle.

**Hold and conn.** A hold (`hold set --kind closed|speccing`) stops work without hiding the board: items can be added and notes and closes land, but claiming and starting work are refused, and `show --ready` comes back empty. Only the owner lifts it. The five display modes in `shared/modes.ts` (manual, hold, spec, clear, full auto) derive from this: a hold wins, and full auto survives underneath. The conn is engine-owned state, rewritten on every nudge; the header shows `♾️(budget)`, solid only while live and within five minutes past its nudge time, with 🏁 while the clear mark is on. Full-auto-clear turns itself off through the close that empties the board.

## 5. The edges

**Two seats, one checkout.** Both append to the one file, each folds its own slice — and both may mint `o1`; the union keys by workspace plus id, holding both without merging. An unscoped writer cannot take a scoped ticket's place, and unscoped lines attribute to their author's workspace through Paseo's agent registry. But a command from a plain terminal, with no agent id, is unscoped and folds the old way — latest start wins — so it can land on another workspace's board. The finished-run error even warns about sandboxes that strip `PASEO_*` variables (symptom: a claim refused with "This run is closed").

**A second run on a live board.** `start` refuses wherever a board exists — live or finished — and its refusal names `show`, `rename` and `--replace`. `--replace` retires the board and reports how many open objectives leave the dashboard; they stay in the file. `finish` refuses until every ticket is done or skipped, no question is open and nothing is flagged stuck.

**What the plugin will not tell you.** Nothing updates until an agent runs the command, and an agent hears about objectives another session added only on its next command, only once. Stale can lie while background subagents work — the waiting agent shows idle, so fifteen quiet minutes warn even while they work. There is no single board across worktrees; state folders outlive deleted worktrees until removed by hand; the plugin never opens its panel by itself. And truth is not enforced: a status says exactly what the agent recorded, no more.

**One code/doc mismatch, now fixed.** `OVERVIEW.md` used to say `isAutoPullable` returns false on a held board, suppressing the ♾️ marks. The code never did that: the mark ignores hold; only `show --ready` empties. `OVERVIEW.md` now says the same. Trust the code.

## Reference

- Statuses: `open`, `in_progress`, `blocked`, `closed`; a close carries `done` or `skipped` (skipped leaves the progress totals). Legacy words (`not_started`, `working`) translate on the fold.
- Priority: integers 0–4, most urgent 0; unset sorts as 5 on screen; the auto-pull band is 0–2; owner-held is 3, 4 and none.
- The board file: `~/.local/state/paseo-progress/<basename>-<sha1-8>/progress.jsonl`, one per worktree; plus `progress.jsonl.lock` and the `progress-panel-opened` marker beside it.
- Saved runs: `history/<start-timestamp>-<title-slug>.jsonl` in the repo, controlled by `paseo-progress.saveRuns` in local git config; default on, off for public origins.
- Key places: `server/cli.ts` (every command), `server/store.ts` (where files live, the saving rule), `server/paths.ts` (`findRoot`), `server/workspace.ts` (agent → workspace resolution), `shared/events.ts` (the schema), `shared/dashboard.ts` (the fold, ordering, stuck and indicator rules), `shared/modes.ts` (the five board modes), `skills/paseo-progress/SKILL.md` (the agent-facing procedure).
- Ids: objectives `o1`, children `o1.1` — never reused; questions `Q1` unique across runs; deliverables `D1`, activity `A1`, stuck `S1` per run.
