---
name: paseo-progress
description: Record progress on the Paseo Progress dashboard with the paseo-progress command. Use when implementing a spec or a set of tickets, running any job with more than 5 steps or over 30 minutes, or when the user asks for a progress dashboard.
---

# Paseo progress

The user watches a live dashboard in Paseo, drawn from the progress file in this worktree. You keep it true by running `paseo-progress` the moment each change happens: the dashboard is a side effect of the work, never a summary written afterwards. Run it from inside the worktree you are working in: it records to that worktree's dashboard, and `show` names the worktree it read. Every command reads and writes the board of the workspace it runs in. `show --all` folds every workspace's current run into one view; `show --mine` shows only your own work, and needs a Paseo agent id, so run it from a Paseo seat; `show --json` prints machine-readable output. `paseo-progress --help` lists every command; `paseo-progress <command> --help` gives its options.

The user answers questions by reference ("Q7 A") and reads everything else at a glance, so every line you record is written for a product manager: plain words, no jargon.

One setup command sits outside any run: `install-launcher [path]` writes the `paseo-progress` launcher (default `~/.local/bin/paseo-progress`) that runs whichever copy of the plugin Paseo is running.

## 1. Set up the run

Run `paseo-progress show`. When it shows an open run for this job, continue it. A run marked Finished is closed, even if it looks like your job; start a new one. Otherwise:

1. `paseo-progress start "<job title>"`, with `--subtitle` naming the spec or ticket folder.
2. Add every ticket in order with `paseo-progress ticket add "<title>" --estimate <minutes>`, with `--waits-for o2` on any that can't start before another finishes. Tickets carry the Beads vocabulary: `open` until work begins, `in_progress` while it runs, `closed` with a close reason (`--close-reason done|skipped`) when it ends. Pass `--priority <0-4>` when urgency matters. Nest a sub-objective with `--under o1`: it becomes o1.1, the next child number, any depth. When a ticket is written up somewhere, a spec file or an issue, pass `--source <path or link>` so the user can open it from the ticket. When it comes from a tracked item, name where with `--ref bead:<id>`, `--ref gh:<owner>/<repo>#<n>` or `--ref teams:<messageId>`; repeat `--ref` to link more than one, and the ticket's name composes from the links. For a job without tickets, add its steps instead and pass `--item-label Step` to `start`; give a step `--source` only when it has a write-up.
3. `paseo-progress activity add "<one line: what this run will do>"`.

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
| The ticket is finished | `ticket done o3` (closes it with reason done), then start the next one |
| The plan drops it but it should stay visible | `ticket update o3 --status closed --close-reason skipped --note "<why>"` |

Pass `--ticket` on every activity, deliverable and question that belongs to a ticket. The user presses a ticket to see its story: each stage and how long it took, with the activity, deliverables and questions tagged to it. Leave it off only for run-wide notes. Stage changes and notes are timed from your `ticket update` calls, so make them when the change happens.

`ticket update o3 --note "<text>"` adds a note without changing status. `activity update A2 "<text>"` rewords a note; `activity remove A2` takes it off the feed. `deliverable remove D1` and `ticket remove o3` take an item off the dashboard — use `--status closed --close-reason skipped` instead when a ticket should stay visible with its reason.

Other sessions may add tickets (or steps) to the same run. When a command's output says another session added one, it is part of the plan: work it in order after your current one, the same as the ones you added.

A working ticket turns stuck on its own once it goes longer than its estimate without an update: a status, stage or note change, or activity tagged to it. When a ticket will run long, keep updating its stage, or raise its estimate with `--estimate`.

A subagent records the work you hand it. Paseo shows you as idle while you wait on it, so its updates are the only sign the work is still going; after 15 minutes without one, the dashboard warns that the work may have stopped. Mark the ticket working, then put this in the subagent's prompt with this worktree's absolute path and the ticket id filled in:

```text
Record progress on the Paseo dashboard as you work:
- at each new stage: cd <worktree> && paseo-progress ticket update o3 --stage <stage>
- between stages:    cd <worktree> && paseo-progress ticker set "<what you are doing now>"
```

The `cd` puts the updates on this worktree's dashboard even when the subagent works in another checkout. When the subagent reports back, mark the ticket done.

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
- A ticket held up by something outside the run (a service, access, a decision nobody has made): `ticket update o3 --status blocked --note "<what it waits on>"`. That shows as stuck. Set it back to `in_progress` when it moves again.
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
