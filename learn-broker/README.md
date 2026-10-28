# learn-broker

The learn-on-paseo broker as a Paseo plugin (server half only): a narrow
HTTP listener beside the daemon that translates a fixed five-op v1 protocol
onto the authenticated `PaseoApi`, with an append-only call log. The learn
service reaches models and agents ONLY through this listener — broker
exclusivity, one surface.

| Op | Route | Notes |
| --- | --- | --- |
| Ensure tutor | `POST /v1/agents/ensure-tutor` | `{workspaceId}` → `{tutorId, created}`, idempotent |
| Create child | `POST /v1/agents/child` | lean five-field payload verbatim → `{childId, bridge}` |
| Archive | `POST /v1/agents/:id/archive` | `{archived}`; false when unknown |
| Timeline | `GET /v1/agents/:id/timeline?includeArchived=` | entries |
| Complete | `POST /v1/complete` | caller `timeoutMs` enforced broker-side |
| Cancel | `DELETE /v1/complete/:callId` | `{cancelled}`; no orphan turns |
| Log | `GET /v1/log` | the append-only log |

Every op response carries its own log entry; 401/400/404 refusals and the
log read carry `log: null` (refused calls are not ops). Errors are honest:
`timeout | aborted | agent_error | transport | unauthorized`.

**Token pairing.** One token, generated once at setup and shown as a pairing
string: paste it into the SERVICE env as `LEARN_BROKER_TOKEN` and into this
plugin's settings file (same value). Never git, never an agent prompt, never the
daemon password. No token configured → the listener refuses to start
(fail-closed).

**Utility-agent ruling (gate ruling 2).** `complete()` runs on ONE REUSED
lean agent, `learn-broker-utility` — created once per daemon, never per
call — with fresh, fully self-contained instructions per call; state bleed
is pinned by test (two calls, distinct payloads, no carry-over).

**Settings home.** Paseo has no per-plugin environment seam: a plugin's config
entry carries only enabled/path/source, `paseo plugin install` has no `--env`,
and a wrapper plugin cannot inject one either — the plugin compiler refuses any
module outside the registered plugin directory, and the daemon runs bundled code.
The daemon unit is the only other home, and changing it means restarting the
daemon.

So the plugin reads its own env file, the one the deployment plans:

```
~/.learnharness/learn-broker.env      chmod 600, never git, never a prompt
```

Format is `KEY=VALUE`, one per line, as a shell would read it: `#` starts a
comment, blank lines are ignored, `export ` is accepted, and one layer of
surrounding quotes is stripped. The real environment still wins, so a shell or a
test can override any value without touching the file.

Settings: `LEARN_BROKER_TOKEN` (required), `LEARN_BROKER_LOG_DIR`,
`LEARN_BROKER_HOST`, `LEARN_BROKER_PORT`, `LEARN_BROKER_PROVIDER`,
`LEARN_SERVICE_URL`, `LEARN_SERVICE_TOKEN`. Contract version 1.

**Binding.** The listener binds `127.0.0.1` by default, on an ephemeral port. A
roaming laptop joins whatever wifi is in range, so `0.0.0.0` would expose the
listener on every one of those networks, and a token gate is not a substitute for
binding. Deployment pins the tailnet address on purpose by setting
`LEARN_BROKER_HOST` in the file.
