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
plugin's env (same value). Never git, never an agent prompt, never the daemon
password. No token configured → the listener refuses to start (fail-closed).

**Utility-agent ruling (gate ruling 2).** `complete()` runs on ONE REUSED
lean agent, `learn-broker-utility` — created once per daemon, never per
call — with fresh, fully self-contained instructions per call; state bleed
is pinned by test (two calls, distinct payloads, no carry-over).

Env seam: `LEARN_BROKER_TOKEN` (required), `LEARN_BROKER_LOG_DIR`,
`LEARN_BROKER_HOST`, `LEARN_BROKER_PROVIDER`, `LEARN_SERVICE_URL`,
`LEARN_SERVICE_TOKEN`. Contract version 1.
