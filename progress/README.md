<img src="https://raw.githubusercontent.com/stevecastaneda/paseo-plugins/main/progress/icon.png" alt="" width="64" height="64">

# Progress

A plugin for Paseo 0.11 and later that gives each worktree a live progress dashboard. Agents record progress with the `paseo-progress` command, which adds one line per change to the worktree's progress file. That file lives outside the repo, so git never sees it. The **Progress** panel draws the dashboard from that file and updates by itself. Several Paseo workspaces can share one checkout: each keeps its own run, and a WS/GIT card in the panel header switches between this workspace's board and every workspace's work in the checkout.

<img src="images/1-panel.png" alt="The Progress panel in Explorer" width="440">

The dashboard shows:

- the run's title and when it was last updated (owner ruling, 12 Oct: the title only — the subtitle and headline lines left the header)
- a tab row — the board, **Beads**, **GH** — with the WS/GIT card at its end: **WS**, the default, shows this workspace's run; **GIT** shows every workspace's current objectives together on one board, with counts over all of them. Inside a git worktree it shows GIT only, because a worktree is already its own checkout. The board's tab is named after the run's item label, **Objectives** by default (`start --item-label` changes it); GH is a calm "GitHub issues: not yet." placeholder
- o-numbered objectives: `o1`, `o1.1`, any depth, indented one step per dot. Numbers are positions in the tree and never renumber; closed items sink below the open ones, sorted by slug with `o2` above `o10`; a parent never shows stuck while any descendant is live. A row's title shows at most 120 characters and its description 200, each ending in an ellipsis; boards recorded with the old `T01` ids display as `o1`, and history files are never rewritten
- a "possibly stale" warning after 15 minutes with no update while tickets remain, unless Paseo shows an agent in the workspace still running, and never once every ticket is done or skipped or the run is finished; working items swap their spinner for a pulsing amber warning
- percent of estimated work done, time done of time estimated (like "1 h 30 min of 2 h"; once everything is done, how long it really took), and a bar with one segment per ticket
- **Stuck:** blocked tickets, working tickets with no update for longer than their estimate, and blockers the agent flags
- **Objectives:** estimate, priority, status, and the working item's stage. Statuses are Beads' terms: open, in_progress, blocked, closed, with the close's reason (done or skipped) beside it. An item that waits for another (`--waits-for o3`) shows it under its title until that one closes; nested waiting rows carry a `>` mark on every tab. Press an item for its story in a dialog. A summary on top shows its status and stage, time worked against the estimate as a bar that turns red past it, the agent's latest status line while it's working, and the agent on it. Tabs below hold the rest, each only when it has something: the item's write-up when it has a `--source` file (the start of it, with the rest a press away), a timeline of its stages and statuses with how long each took, and the activity, questions and deliverables that belong to it. The agent on an item shows by its chat title; pressing it opens that chat. Items tagged with `--ticket` belong exactly; older, untagged ones are matched by when they happened and marked "by time". Where the work came from shows as chips at the bottom of the card — a bead chip and a GitHub chip that opens the issue — each only when present
- **Questions:** each with a permanent reference (Q1, Q2, ...), lettered options, and the option the agent recommends. The agent builds nothing a question affects until you answer; it works on other things meanwhile, and stops when nothing else is left. Press a question to open it in a dialog, then press **Copy Q2 B** to copy `Q2 (title): B` for your reply. Files and links the agent attached (`--file`) open like deliverables: images and text files preview in Paseo (with **Back** to the question), links open in Paseo's browser, and other files open in their default app. From the pill's popover, the preview opens over the popover, which stays open so you can go back to it. Answers stay listed under the same reference.
- **Activity**, **Answered** questions and **Deliverables** (press one to open it), sharing one card with a tab for each; the panel remembers the tab you picked. Each shows the newest 10, with **Show 10 older** below

<img src="images/2-ticket.png" alt="A ticket's story: its status, time against the estimate, the agent on it, and its timeline" width="400"> <img src="images/3-question.png" alt="A question waiting for an answer, with lettered options, the agent's recommendation and Copy buttons" width="400">

The panel lives in Explorer, beside the agent chat, so you can watch both. Open it from Command Center with **Open Progress**. When questions are waiting or something is stuck, a pill above the message box shows it (`3 questions · 1 stuck`). Pressing it opens a popover with each open question, its choices and their Copy buttons, and what is stuck, so you can answer without leaving the chat. **Open Progress** at the bottom opens the panel in Explorer.

<img src="images/4-pill.png" alt="The pill above the message box, showing two questions waiting" width="600">

On phones, where Paseo has no Explorer pane, Progress opens as a tab of its own, and the pill stays above the message box while a run is open so there's always a way in. SVG files preview on desktop; on phones they open on the daemon host.

The first time a run starts in a worktree whose Progress panel has never been opened, the pill shows a spinner and reads **Progress** instead; pressing it opens the panel. Once the panel has been opened there, the plugin writes an empty `progress-panel-opened` file next to the progress file and the nudge never comes back, even for later runs. It doesn't open the panel by itself because Paseo switches to a workspace to open its panel, which would pull you away from whatever you're looking at.

## Install

```sh
paseo plugin add npm:@stevecastaneda/paseo-progress
```

Or from Paseo's plugin registry: `paseo plugin add stevecastaneda/progress`.

Enable plugins under **Settings → Plugins** on the Paseo host. You need Node.js 22.18 or later on the daemon host.

Then install the `paseo-progress` command agents run. Open **Progress** from Command Center and press **Install command** in the banner. It adds one file, `~/.local/bin/paseo-progress`, on the machine running the Paseo daemon, and the banner disappears once agents can run it. The plugin writes nothing until you press it, and it never replaces a file something else put at that path.

To install from a terminal instead, or to put the command somewhere else:

```sh
dir="$(paseo plugin ls progress --json | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].path')"
node "$dir/server/cli.ts" install-launcher [path]
```

If `paseo` isn't on your `PATH`, use `/Applications/Paseo.app/Contents/Resources/bin/paseo`. The command doesn't name a plugin folder: each run asks Paseo (`paseo plugin ls`) which copy of the plugin it is running and runs that copy, so it keeps working after updates and `npm run dev` switches. It always runs the plugin's source, `server/cli.ts`, the same code a reload hands the panel, so the command never lags behind the panel.

## Where progress is kept

Each worktree's progress lives outside the repo, in its own folder under `~/.local/state/paseo-progress/` on the daemon host. There's nothing to set up and nothing to hide: git never sees these files, and the plugin never edits a `.gitignore` or git's exclude file. The panel's empty state shows the exact path.

### Saving run history to the repo

If you want to keep runs, at the bottom of the panel press **Save to repo…** and pick a folder (or name a new one). From then on, each run is saved as its own file there, like `history/20261001-064512-export-feature.jsonl`, and updated as the run goes. Commit them like any other file. One file per run means two branches never write the same file, so merges don't conflict. The lock and the panel marker never go there.

The choice covers every worktree of the repo and is kept in the repo's local git config (`paseo-progress.saveRuns`), which nothing commits. **Change…** picks another folder for future runs; **Stop saving** turns it off. Files already saved are never moved or deleted.

### Upgrading from 0.1.x

Earlier versions kept progress in `.scratch/` in each worktree, hidden by a `.scratch/.gitignore` they wrote. The first time the command or the panel touches a worktree after the upgrade, the plugin moves its files out of `.scratch/` and removes that `.gitignore` if it's exactly the one the plugin wrote. If `.scratch/` is then empty, it goes too; anything else you keep there stays. If git tracks the old progress file (for example, an agent committed it), the plugin leaves it where it is and keeps using it, so nothing changes in that repo.

## Workspaces

A Paseo workspace is not a path. Two workspaces can work on one checkout — same folder, same repo — so a run cannot be told apart by where it happened. Every event written from a Paseo seat carries its workspace id next to the agent id, and the dashboard folds only the slice that belongs to yours. Events with no workspace id — runs recorded by 0.4.0, or a command run from a plain terminal — stay visible in every view.

Nothing needs setting up. The command reads the workspace id from the agent's Paseo record and stamps it on every event, and every event also carries its author's agent id. When the file is folded, an event with no workspace id is attributed to its author's workspace, resolved through Paseo's agent registry — so a missed stamp lands the work where it belongs anyway. A command run from a plain terminal, with no agent id at all, stays unscoped: it folds the file the way 0.4.0 did, the latest `start` winning, and its events show in every view.

An item also learns its home: once a workspace owns it, later unscoped events on it fold into that workspace. A workspace stamped on events but with no run of its own still shows in the All view rather than vanishing. And work moves between workspaces without forks: `ticket move` hands an item to another workspace (children follow), and `ticket claim-from-all` pulls one you can see in All into yours — both append a correction event; nothing already written is rewritten.

One progress file still holds the whole checkout. Scoping happens when the file is read, so moving from 0.4.0 resets nothing: old lines are still there and still show.

The GIT side of the toggle (and `show --all`) is the union: every workspace's current-run tickets together on one board — both `T01`s if two workspaces each minted one — with counts and percent over all of them. No workspace's board goes empty because another one is busy.

## Agent skill

The plugin ships an agent skill, `paseo-progress`, that tells agents when to run each command during a multi-ticket job: set up the run, move tickets through their stages, ask questions without stopping, flag stuck work, and finish. Press **Install skill** in the Progress panel. It links `paseo-progress` into `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills` (the folders Paseo installs its own skills into), pointing at the copy of the plugin Paseo runs, so plugin updates reach agents. If Paseo later runs the plugin from somewhere else, the button changes to **Update skill**. It never replaces a skill it didn't link; that folder is skipped.

From a terminal instead:

```sh
skill="$(paseo plugin ls progress --json | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].path')/skills/paseo-progress"
for dir in ~/.agents/skills ~/.claude/skills ~/.codex/skills; do mkdir -p "$dir" && ln -s "$skill" "$dir/paseo-progress"; done
```

## Recording progress

Run `paseo-progress --help` for every command, and `paseo-progress <command> --help` for one. Commands find the worktree root from the current directory.

```sh
paseo-progress start "Loan Options snapshots" --subtitle "4 objectives"
paseo-progress ticket add "Fix the saved table" --estimate 120 --priority 2 \
  --source specs/01-saved-table.md                                     # Added o1
paseo-progress ticket add "Table tests" --estimate 60 --under o1        # Added o1.1
paseo-progress ticket claim o1 --stage Build                            # Claimed o1
paseo-progress ticket update o1 --stage Fixes
paseo-progress ticket done o1 --note "Green in CI."
paseo-progress ticket update o1.1 --status closed --close-reason skipped
paseo-progress question ask "Row spacing" "Even out the card spacing?" \
  --option "A=Even it out | Cards look balanced" \
  --option "B=Leave it | No change" \
  --recommend A --raised-by "Saved table design review"                # Asked Q1
paseo-progress question answer Q1 A --words "Even it out."
paseo-progress deliverable add "Browser check screenshots" .scratch/shots/ --ticket o1
paseo-progress activity add "Saved table matches the design now." --ticket o1
paseo-progress ticker set "Running the browser check"
paseo-progress stuck set "Staging is down" --ticket o1                  # Flagged S1
paseo-progress show
paseo-progress finish "Snapshots ship for all four tables"
```

Claiming and closing cost one call each, an item can carry where its work came from, and work moves between workspaces without forks:

```sh
paseo-progress ticket add "Help text" --estimate 60 \
  --ref bead:pp-ti5 --ref gh:bank/loans#412    # Added o2: ref bead:pp-ti5, gh:bank/loans#412
paseo-progress ticket move o2 --to wks-billing                       # Moved o2 to wks-billing
paseo-progress ticket claim-from-all o2        # Claimed o2 into your workspace
paseo-progress show --mine
paseo-progress show --all
paseo-progress show --json
```

- Statuses are Beads' terms: `open`, `in_progress`, `blocked`, `closed`. A close carries its reason — `done` (the default) or `skipped`; skipped items leave the totals. `ticket claim <id>` sets `in_progress` and stamps you as the one on it; `ticket done <id>` closes as done. Both take `--note`; claim also takes `--stage`.
- Ids are o-numbers: `o1`, `o1.1`, any depth — the position in the tree. `--under <id>` nests an item as a child; numbers are stable once set, holes are fine, and nothing renumbers. `--priority <0-4>` says how urgent it is. `start --item-label <word>` names the board's items — Objective by default; the tab, the headline and `show` all use it.
- `ticket add` and `ticket update` take an optional `--source <path or link>[=<label>]`: where the ticket is written up, like its spec file or issue. It shows under the ticket's status in its dialog and opens like a deliverable. `--source ""` clears it. Tickets without one are fine.
- A working item is stuck once it goes longer than its estimate without an update, timed from its last status, stage or note change, or activity tagged to it. The dialog still shows total time worked against the estimate.
- `question ask` needs `--recommend`, the agent's pick. The question dialog tags that option "Recommended".
- Deliverable paths are stored relative to the worktree root. Web links open in Paseo's browser. Pressing an image (PNG, JPEG, GIF, WebP, up to 10 MB) or text deliverable (Markdown, text, logs, JSON, YAML, CSV; the first 256 KB) previews it in a dialog inside Paseo, which also works from a phone; **Open** there opens the file in its default app. Pressing any other local deliverable opens it with its default app on the machine running the Paseo daemon (for example HTML in your browser and folders in the file manager). On macOS, **Open** sends text files to your default browser. Only recorded deliverables inside the worktree open this way; otherwise the path is copied. The copy icon on each row copies the path.
- Several agents can share one run. When another session adds an objective, each agent sees it at the end of its next command's output (and in `show`), and the skill has it work that objective in order after its current one. An agent only hears about objectives added since its own last update in the run, and only once.
- Subagents record their own progress. Since Paseo 0.11, an agent waiting on background subagents shows as idle, so only the subagents' updates show the work is still going. The skill has the agent give each subagent the worktree path and ticket id, and the subagent records its stages and a ticker line on that worktree's dashboard.
- `start` begins a fresh dashboard. Earlier runs stay in the file. Question references stay unique across runs.
- `finish "<outcome>"` closes the run once every ticket is done or skipped, no question is open, and nothing is flagged stuck; otherwise it says what is left. The run stays on the dashboard, marked Finished with its outcome, and takes no more updates, so the next agent in the worktree starts a new run instead of adding to it.
- `show --mine` prints only your objectives and open questions in this run, matched on your agent id. `show --all` prints every workspace's current-run objectives together, with counts over all of them. `show --json` prints the dashboard as JSON instead of text, and combines with either: `--mine --json`, `--all --json`. Plain `show` is unchanged.
- `ticket move <id> --to <workspace-id>` hands an item to another workspace: it leaves your board and renders on the target's, children following the parent. `ticket claim-from-all <id>` claims an item you can see in `show --all` into your workspace — the same move, one word, from a seat that resolves a workspace. Both append a correction event; nothing already written is rewritten.
- `ticket add` and `ticket update` take an optional `--ref <ref>` — `bead:<id>`, `gh:<owner>/<repo>#<n>`, `teams:<message id>` — and it repeats: each `--ref` adds a link. The panel shows the links as chips on the row. `--ref` is not `--source`: `--source` is where the item is written up, `--ref` is where the work came from. Closing an item closes the beads linked to it, through `bd`; a close that fails says so on the command's output, and you finish it.

## The progress file

The progress file, `progress.jsonl`, holds one JSON event per line, each with a version (`v`), a UTC timestamp (`ts`) from the real clock, and a `type`. Events written by a Paseo agent also carry its agent id (`by`). It is only ever appended to, so you can read or diff the history. A half-written last line is ignored. Other bad lines are skipped and listed in a small notice in the panel while the rest still renders. A lock keeps two commands from writing at once or handing out the same id. Events written from a Paseo seat may also carry its workspace id. Boards recorded with the old `T01`-style ids display as `o1` positionally — the translation happens when the file is read, and history is never rewritten.

## The Beads tab

The Beads tab shows this repo's beads: one row per issue, with a priority pill (P0–P4), the issue id, its title and its status. Children nest under their parent, indented like the objectives board. Closed beads are listed too (`bd --all`) and sink behind a count header that opens to show them; a bead closed as skipped is struck through. The tab re-reads the record every 10 seconds, and it needs the `bd` command on the daemon host. Reads run `bd --readonly -C <repo-root> list --json --all --limit 0`.

Press a bead for its detail: description, priority, status, the full record. From there you can change its status, or press **Upgrade** to promote it to an objective on the board — a new objective carrying `--ref bead:<id>`, estimated at an hour to start. Every write goes through `bd` itself (`bd update`, `bd close`); the plugin keeps no copy of the record. Beads stays the record.

Two calm states, each in its own words: a repo with no `bd`, or no `.beads/` folder, says "No beads in this repo"; a repo whose `bd` answers with an empty list says "No open beads". If `bd` fails, the tab shows its message, never a stack.

## This fork, deploying it, and rolling it back

This is the 0.4.0-df fork of the plugin, version 0.4.0-df.10 (df.2 through df.10 carried the objectives overhaul, one landing each). It runs live from this checkout: `npm run dev` in the plugin folder swaps it into Paseo, and `paseo plugin ls` shows `progress` running from the folder.

Deploying a change is one move: bump the patch version, then `paseo plugin reload progress`. The reload is the whole deploy — the daemon recompiles the panel and the server from source, open apps pick up the new panel without a restart, and the `paseo-progress` launcher runs `server/cli.ts` directly. There is no build step and no `dist/`; the CLI and the panel always run the same source.

To go back to the published plugin:

```sh
paseo plugin remove progress
paseo plugin add npm:@stevecastaneda/paseo-progress
```

`paseo plugin ls` then shows `progress` running from `~/.paseo/plugins`, and the panel loads from the published build. For the registry build instead: `paseo plugin add stevecastaneda/progress`. Both directions were exercised when this fork was built: removed, added back, checked, then the fork swapped in again with `npm run dev`, ending with the fork live.

## Limitations

- An agent hears about tickets other sessions added only when it next runs `paseo-progress`. One in the middle of a long step finds out when that step ends.
- Nothing updates unless the agent runs `paseo-progress`. Agents need the skill, and an agent that skips the command leaves the dashboard behind.
- On Paseo 0.11 and later, an agent waiting on background subagents counts as idle. If those subagents record nothing, the dashboard shows "possibly stale" after 15 minutes while they're still working.
- The command runs on the machine that hosts the Paseo daemon, and it needs Node.js 22.18 or later there.
- Each worktree keeps its own dashboard. There's no view across worktrees.
- Progress folders outside the repo stay behind when a worktree is deleted. They're small, and you can delete them from `~/.local/state/paseo-progress/`.
- Paseo can't open a panel without switching you to its workspace. So a new run shows a "Progress" pill, and you open the panel yourself.
- Pills check busy worktrees every 5 seconds and quiet ones every 30. In a quiet worktree, a new question can take up to half a minute to show.
- Previews cover images up to 10 MB and the first 256 KB of a text file. Other files open in their default app.
- Stale warnings and overdue times use the daemon host's clock.
- `show --mine` needs a Paseo agent id. From a plain terminal it exits with a note saying so, and prints nothing.

## Changelog

### 0.4.0-df.10

Versions df.2 to df.10, one landing each, carried the objectives overhaul:

- The board became objectives: o-numbered ids (`o1`, `o1.1`, any depth, `--under` to nest), Beads' status vocabulary (`open`, `in_progress`, `blocked`, `closed`, with a close reason of `done` or `skipped`), priority 0–4, and a board label (`start --item-label`, default Objective). Old `T01` ids display as `o1`; history files are never rewritten.
- Parents roll up liveness — never stuck while a descendant is live; closed items sink below the open ones; nested waiting rows carry a `>` mark on every tab; row titles clamp at 120 characters, descriptions at 200.
- `--ref` repeats (bead, GitHub, Teams links) and shows as chips on the row; closing an objective closes its linked beads through `bd`.
- The Beads tab lists closed beads too (they sink behind a count header), nests children, refreshes every 10 seconds, and gained a detail view: status changes and bead-to-objective upgrade, every write going through `bd`. Beads stays the record.
- Work reallocates between workspaces: `ticket move <id> --to <workspace>` and `ticket claim-from-all <id>`; children follow, corrections are appended, nothing is rewritten.
- Unscoped events are attributed to their author's workspace through Paseo's agent registry; an item keeps its learned home; the unscoped same-id shadowing defect (D-4) is fixed.
- The CLI runs from source; the `dist/` snapshot is gone. Deploying is a version bump and a plugin reload — nothing else.
- Panel polish: the header shows the title only, the WS/GIT toggle moved to the end of the tab strip, tighter rows and spacing.

### 0.4.0-df.1

- The 0.4.0-df fork: 0.4.0 unchanged, plus what follows. The version marks the fork; nothing from 0.4.0 was renamed or removed.
- Runs scope per Paseo workspace, so two workspaces on one checkout each keep their own run. A WS/GIT card in the panel header switches between this workspace and the union of every workspace's current tickets. Inside a git worktree the card shows GIT only.
- The panel's tickets card became a tab row: **Tickets · Beads · GH Issues**. Beads is a read-only view of this repo's beads; Beads stays the record. GH Issues is a calm placeholder.
- New CLI verbs and flags: `ticket claim`, `ticket done`, `--ref` on `ticket add` and `ticket update`, and `show --mine`, `--all`, `--json`.
- A ticket's `--ref` shows as a chip on its row in the panel.
- Rolling back to the published plugin: `paseo plugin remove progress`, then `paseo plugin add npm:@stevecastaneda/paseo-progress`. See "This fork and how to roll it back".

### 0.4.0

- Needs Paseo 0.11 or later. The plugin now carries its own icon and screenshots, and Paseo 0.9 and 0.10 refuse to load a plugin that does. On an older Paseo, the version you already have keeps working.
- The plugin store now takes the icon and screenshots from each release, so they match the version you install.
- New screenshots in this README.

### 0.3.5

- The plugin's page in Paseo's plugin store now says that pressing **Open** in a preview opens the file in an app on the computer running the Paseo daemon, even from your phone.

### 0.3.4

- Installing the plugin no longer downloads any other npm packages. The `paseo-progress` command is now built into a single file that includes zod. The plugin used to install `@getpaseo/client` just for its types; it now gets them from the plugin SDK that Paseo already provides.

### 0.3.3

- The skill now has subagents record their own progress, so the dashboard stops warning "possibly stale" while they work. Since Paseo 0.11, an agent waiting on background subagents shows as idle. After 15 minutes with no update, the dashboard said the work may have stopped even though the subagents were still at it. Now the agent gives each subagent the worktree path and ticket id, and the subagent records its stages and a ticker line. If the Progress panel shows **Update skill** after you update, press it so agents get the new instructions.

### 0.3.2

- The plugin's page in Paseo's plugin store now uses the plugin's own description instead of text the store copied from paseo.cafe.

### 0.3.1

- Installs again with npm 12. Installing failed with `npm ci` asking for a `package-lock.json`, because npm 12 no longer reads the lockfile this plugin shipped ([#53](https://github.com/stevecastaneda/paseo-plugins/issues/53)). The plugin no longer runs its own install step; Paseo's npm install already brings in what it needs.
- Install from npm or Paseo's plugin registry. Installing straight from GitHub no longer works.
