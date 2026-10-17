---
name: paseo-progress
description: Record progress on the Paseo Progress dashboard with the paseo-progress command. Use when your task names an objective on the board, when the sponsor or the user asks you to start a run or add objectives, or when the user asks for a progress dashboard. Your own steps stay on your task list; the board holds objectives only.
---

# Paseo progress

The user watches a live dashboard in Paseo, drawn from the progress file in this worktree. You keep it true by running `paseo-progress` the moment each change happens: the dashboard is a side effect of the work, never a summary written afterwards. Run it from inside the worktree you are working in: it records to that worktree's dashboard, and `show` names the worktree it read. Every command reads and writes the board of the workspace it runs in. `show --all` folds every workspace's current run into one view; `show --mine` shows only your own work, and needs a Paseo agent id, so run it from a Paseo seat; `show --json` prints machine-readable output; `show --status <open,in_progress,blocked,closed>` and `show --priority <0-4, none, a list or a range like 0-2>` cut the objectives; `show --ready` lists what a seat may pull (open or in progress, P0 to P2 — P3, P4 and none are owner-held); `show --workspace <id>` reads another workspace's board. `paseo-progress --help` lists every command; `paseo-progress <command> --help` gives its options.

Run `paseo-progress` from the plain shell tool, never inside a context-mode sandbox (`ctx_execute`, `ctx_batch_execute`) and never through `rtk`: they strip every `PASEO_*` variable, so the command cannot tell who you are (it needs `PASEO_AGENT_ID` to find your workspace) and reads the wrong board. Symptom: a claim says "This run is closed" and your objective shows as an unknown ticket, while the same command from the plain shell works.

The user answers questions by reference ("Q7 A") and reads everything else at a glance, so every line you record is written for a product manager: plain words, no jargon.

One setup command sits outside any run: `install-launcher [path]` writes the `paseo-progress` launcher (default `~/.local/bin/paseo-progress`) that runs whichever copy of the plugin Paseo is running.

## 1. Set up the run

To change the board's name later, use `paseo-progress rename "<title>" [--subtitle <text>]` (`--subtitle ""` clears the subtitle); it works on a finished run too and leaves ids and history alone.

The board holds objectives, the outcomes the user watches, and nothing else. Your own steps stay on your own task list. Starting a run and adding objectives is for the sponsor that launched you, or for when the user asks you to: never because a job is long. When your task names an objective, run `paseo-progress show`, find it and claim it (section 2). A board marked Finished is still this workspace's board; begin a fresh one with `start --replace` only when the sponsor or the user tells you to.

A board is one persistent object per workspace. Always run `paseo-progress show` first and work the board that is there; when the theme changes, rename it with `paseo-progress rename "<title>"`. `start` is only for a workspace that has never had a board, and it refuses anywhere else; never retire a live board to begin new work. (`start --replace` exists as a deliberate override, and says how many open objectives it drops; use it only when the user tells you to.) When you are the sponsor, or the user asked you to set up a workspace's first board, and `show` says there is no run yet:

1. `paseo-progress start "<job title>"`, with `--subtitle` naming the spec or ticket folder.
2. Add every ticket in order with `paseo-progress ticket add "<title>" --estimate <minutes>`, with `--waits-for o2` on any that can't start before another finishes. Tickets carry the Beads vocabulary: `open` until work begins, `in_progress` while it runs, `closed` with a close reason (`--close-reason done|skipped`) when it ends. Pass `--priority <0-4>` when urgency matters. Nest a sub-objective with `--under o1`: it becomes o1.1, the next child number, any depth. To group an objective that already exists, move it with `ticket update o93 --under o95` (`--under ""` lifts it back to the top level): it keeps its id, status, claim and notes, its children go with it, and a move under its own child is refused. When a ticket is written up somewhere, a spec file or an issue, pass `--source <path or link>` so the user can open it from the ticket. When it comes from a tracked item, name where with `--ref bead:<id>`, `--ref gh:<owner>/<repo>#<n>` or `--ref teams:<messageId>`; repeat `--ref` to link more than one, and the ticket's name composes from the links. For a job without tickets, add its steps instead and pass `--item-label Step` to `start`; give a step `--source` only when it has a write-up.
3. `paseo-progress activity add "<one line: what this run will do>"`.
4. Run saving is on by default: every run is written to `history/` in the repo as its own `.jsonl` file as it goes, committed like any other file. You do nothing. It stays off when the repo's origin is on a public forge (github.com, gitlab.com or bitbucket.org), because a public repo would publish the run notes. Only the owner changes it: the panel's Save to repo… button picks a folder and overrides the public rule, and Stop saving turns it off for good. The same setting is `git config --local paseo-progress.saveRuns <folder>`, and an empty value means off.

Done when `show` lists every ticket with an estimate.

## 2. Work each ticket

Record each change as it happens, on the ticket's id from `show` (o1, o2, ...):

| When | Command |
| --- | --- |
| You take a ticket | `ticket claim o3 --stage Build` — it sets the ticket in_progress and stamps you as the one on it |
| You move to the next stage | `ticket update o3 --stage Review`, then `Fixes`, then `Verify` |
| Something reviewable lands (a screenshot folder, a report, a preview URL) | `deliverable add "<what it shows>" <path or URL> --ticket o3`, with `--kind file`, `folder`, `report`, `screenshot` or `link` when the path alone doesn't say which |
| A milestone the user would want in the story | `activity add "<one line>" --ticket o3` |
| Between bigger events | `ticker set "<what you are doing right now>"`, then `ticker clear` when it no longer applies |
| The ticket is finished | `ticket done o3 --note "<the proof>"` (closes with reason done). The close note is where the proof goes: the test count, the SHA, or the check that passed — no proof, no done. Then start the next one |
| The plan drops it but it should stay visible | `ticket update o3 --status closed --close-reason skipped --note "<why>"` |
| The ticket belongs on another workspace | `ticket move o3 --to <workspace-id>` — it leaves this workspace's board and renders only on the target's (and `show --all`). Children follow the parent. Nothing is rewritten; a correction event is appended |
| A ticket from another workspace's board should be yours | `ticket claim-from-all o3` — the same reallocation, with the target defaulting to your workspace |
| You want one objective's facts | `ticket show o3` — its status, priority (when set), estimate and name; `ticket show o3 --json` gives the whole objective for a machine |

Pass `--ticket` on every activity, deliverable and question that belongs to a ticket. The user presses a ticket to see its story: each stage and how long it took, with the activity, deliverables and questions tagged to it. Leave it off only for run-wide notes. Stage changes and notes are timed from your `ticket update` calls, so make them when the change happens.

`ticket update o3 --note "<text>"` adds a note without changing status. `activity update A2 "<text>"` rewords a note; `activity remove A2` takes it off the feed. `deliverable remove D1` and `ticket remove o3` take an item off the dashboard — use `--status closed --close-reason skipped` instead when a ticket should stay visible with its reason.

Other sessions may add tickets to the same run. When a command's output says another session added one, that is awareness, not an order: work it only when it is yours or your task names it. A ticket another agent added stays with them.

A working ticket turns stuck on its own once it goes longer than its estimate without an update: a status, stage or note change, or activity tagged to it. When a ticket will run long, keep updating its stage, or raise its estimate with `--estimate`.

A subagent records the work you hand it. Paseo shows you as idle while you wait on it, so its updates are the only sign the work is still going; after 15 minutes without one, the dashboard warns that the work may have stopped. Mark the ticket working, then put this in the subagent's prompt with this worktree's absolute path and the ticket id filled in:

```text
Record progress on the Paseo dashboard as you work:
- at each new stage: cd <worktree> && paseo-progress ticket update o3 --stage <stage>
- between stages:    cd <worktree> && paseo-progress ticker set "<what you are doing now>"
```

The `cd` puts the updates on this worktree's dashboard even when the subagent works in another checkout. When the subagent reports back, mark the ticket done.

## Priorities: how the board is ordered, and how to work it

Give an objective a priority when urgency matters: `--priority <0-4>` on `ticket add` or `ticket update`. The scale mirrors Beads:

| Priority | Meaning |
| --- | --- |
| P0 | Most urgent: drop what you can and take it |
| P1 to P4 | Less and less urgent |
| none | Counts as 5: it sits after P4, at the bottom |

Only P0, P1 and P2 are pulled to run under full auto; P3, P4 and none are owner-held. So a child added with `--under` and no `--priority` takes its parent's priority when the parent is P0, P1 or P2, and the output says so (`Added o12.3: ..., at P0 (from o12)`). A child under a P3, P4 or unprioritised parent stays unprioritised, and an explicit `--priority` always wins. Still set the priority yourself on anything you hand to a helper.

The panel and `show` order objectives the same way Beads are ordered: by priority band first (P0, then P1, down to P4, then none), and inside a band by o-number, lowest first. A sub-objective orders the same way among its siblings and stays under its parent. Closed objectives sink below the open ones.

Work the list from the top down. Finish the P0s first. When there are no P0s left, the P1s are next, then the P2s, and so on. Do not skip ahead to a lower band because it looks easier or more interesting.

This is guidance, not automation. Nothing triages for you: do not re-rank other people's objectives, and do not start work that is not yours because it sits high in the list. Take what your task names. The ordering and the priority numbers are there so that auto-triage can be switched on for an agent later; until someone does that, use priorities to say how urgent your own objectives are, and to read the order of the board.

## Statuses are true, and Des to UAT (Des, 14 Oct)

The board must read true at a glance. Built and tested is Done: `ticket done <id> --note "<the proof>"` (test count, SHA, smoke result). Waiting for Des is not a status — never leave finished work `in_progress` or `open` to mean "he has not looked yet". In progress means an agent is working on it right now; open means not started or held. The CLI has no held status: Held is a stage plus a priority (`ticket update <id> --stage "Held" --priority <n>`), and a wait on a third party carries a stage that names who — "Waiting for <who>", such as "Waiting for Catherine".

**Des to UAT.** Whenever Des must put eyes on something or UAT it, keep one standing top-level objective titled "Des to UAT" (waiting for Des, priority 0, stage "Waiting for Des"), with the pack or file as its `--source`. Add ONE child per thing Des must look at, titled `Des: <what he checks and what passing looks like> (<objective id>, <pack section>)`, about 10 minutes each; the child is his reminder to review. A doer or a sponsor may create this objective — the one explicit exception to "never create a top-level objective". Mark any Salesforce-write step inside a UAT child as needing Des's go.

**Close-out check.** Before ending a turn, and whenever Des asks "where do we stand", run `paseo-progress show` and read it: every status must be true — nothing finished sits in progress, nothing waiting on Des sits outside Des to UAT.

## Hold: the board is open for items, closed for work (Des, 15 Oct)

Des puts a board on hold with `hold set --kind <closed|speccing> [--note <text>]` and lifts it with `hold clear`. `closed` means closed to work. `speccing` means Des is here speccing the work with you.

- On hold, add all the objectives you like. Notes, priorities, blocks and closes also work, so running work can finish.
- On hold, nothing starts. `ticket claim` and moving an objective into progress are refused, with a message that names the hold.
- `show` prints a `Hold:` line and `show --json` carries `dashboard.hold`. `show --ready` lists nothing. A hold only pauses full auto: the conn state, the ♾️ on your names and the ♾️ on P0-P2 objectives all stay, and full auto resumes by itself when the owner clears the hold.
- Only the owner lifts a hold. Do not run `hold clear` yourself.
- The DCI engine reads `dashboard.hold` and does not nudge or pull while it is on.

```yaml
HOLD:
  - bad: the claim is refused, so you start the work without claiming it
    good: add the objective, write its spec in the note, and wait for the hold to lift
```

## Full auto (conn): what the engine writes on your board

The DCI engine stores its full-auto state on the board itself: `conn set --budget <n> --mode <live|keepalive> --next-nudge-at <iso>` writes it, the engine rewrites it on every nudge, and `conn clear` lifts it. You never run these yourself. `--clear` on `conn set` marks full-auto clear — work the board down, then turn off at idle; a rewrite without it drops the mark. While conn is on, `show` prints the conn state and the indicator with it, and the panel marks what full auto would pull (open or in progress, P0 to P2) with ♾️. `--workspace <id>` on `conn set` and `conn clear` targets another seat's board from outside it.

## 3. Ask questions, and work around them

When a decision belongs to the user, ask it, then park everything the answer affects:

```sh
paseo-progress question ask "<short title>" "<the question, in one or two sentences>" \
  --option "A=<choice> | <what happens if they pick it>" \
  --option "B=<choice> | <what happens if they pick it>" \
  --recommend <letter> --ticket o3 --raised-by "Widget design review" \
  [--background "<what they need to decide without opening the worktree>"] \
  [--file <path or http(s) URL>=<what it shows>]
```

- `--recommend` is the option you would pick, so the user knows which way to lean.
- Build no option before the user answers, not even the one you recommend. The point of asking is that the user decides before the work is done.
- Keep working on whatever the question doesn't affect: other tickets, or other parts of this one. If nothing else is left, stop, tell the user in chat which questions you're waiting on, and leave the run open.
- When the user replies ("Q7 A", or in their own words), run `question answer Q7 A --words "<their words>"`, then build what they chose.
- When a question is about how something looks, attach the screenshot, mockup or preview link with `--file`. The user opens it from the question: images preview in Paseo, links open in its browser. Add more later with `question update Q7 --file <path>=<what it shows>`.
- When the user asks about a question, answer in chat and also put the explanation on the question with `question update Q7 --background "<text>"`, so the dashboard carries it too.
- `question remove Q7` withdraws a question that no longer applies.

## 4. Flag what is stuck

- A ticket that has to wait for another ticket in this run is not stuck; that's just the order of work. Record it with `ticket add ... --waits-for o3` (or `ticket update o5 --waits-for o3`) and leave its status alone. The dashboard shows it calmly as waiting until o3 is done.
- A ticket held up by something outside the run (a service, access, a decision nobody has made): `ticket update o3 --status blocked --note "<what it waits on>"`. That shows as stuck. Set it back to `in_progress` when it moves again. A parent objective never shows stuck while a sub-objective under it is live (in progress, or active after the parent was marked): the parent shows as running until nothing under it is live.
- A blocker outside any ticket (a failing service, a missing key): `stuck set "<reason>" [--ticket o3]`, then `stuck clear S1` once it is gone.

## 5. Finish

When the job is over:

1. Close the last ticket: `ticket done o3`, or `ticket update o3 --status closed --close-reason skipped --note "<why>"`.
2. Settle every open question: record the user's answer, or withdraw it with `question remove` when it no longer applies. Clear flagged blockers with `stuck clear`.
3. `paseo-progress finish "<one line: the outcome>"`. It refuses, and says what is still open, until the steps above are done.
4. Run `paseo-progress show`.

The finished run stays on the dashboard, marked Finished with its outcome, until the next `start`. It takes no more updates.

If the job pauses with questions only the user can answer, don't finish: leave the run open so the questions stay in front of them.

Done when `show` says Finished with the right outcome.
