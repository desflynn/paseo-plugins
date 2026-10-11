# overlays

This folder tracks the changes this fork carries on top of upstream. It lives on the `-df` branch only. It never goes to `main` and never goes into a PR branch.

- Upstream: `stevecastaneda/paseo-plugins` (MIT).
- Base: upstream `main` at `6f6001f`.
- First scope: the `progress` plugin (`progress/`, `@stevecastaneda/paseo-progress`, 0.4.0). The whole repo is here because `progress` uses the shared `scripts/`.
- `time-since` and `history` also run from this folder, so we can customize them.

## Changes

One line per change: what it does, why it exists, and the upstream PR link if there is one.

| Change | Why | Upstream PR |
| --- | --- | --- |
| none yet | | |

## Moving to a new upstream version

Compare the full delta between this branch and the new upstream first. Never blindly reapply.
