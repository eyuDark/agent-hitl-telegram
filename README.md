# agent-hitl-telegram

Distributed **Human-in-the-Loop (HITL) Agent Authorization Engine**.

Agents (LangGraph, Vercel AI SDK, Claude Code, OpenCode, Cursor) pause on privileged tool calls and wait for a human to approve or deny them from Telegram. Approvals are distributed state transitions backed by Redis CAS + BullMQ, with an immutable PostgreSQL audit ledger.

```
Agent ──POST /v1/approvals──► Gateway ──► PostgreSQL (PENDING ledger row)
                         │            ──► Redis (hitl:req:{shortId} hot state)
                         │            ──► BullMQ (dispatch + delayed TTL job)
                         ▼
                 grammY worker ──sendMessage + inline keyboard──► Telegram

Operator taps ✅ / ❌
Telegram ──callback webhook──► Gateway ──Lua CAS (PENDING → APPROVED/DENIED)──► Redis
                                    │
                                    ├──► BullMQ resolution worker ──► ledger update,
                                    │                              message edit, event publish
                                    └──► BullMQ resume worker ──signed POST──► agent callbackUrl
```

## Why this stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 22 + TypeScript (ESM, project references) | Shared types across gateway, workers, MCP server, SDK |
| HTTP | Fastify 5 | JSON-schema validation, high throughput, first-class hooks |
| Orchestration | BullMQ (Redis) | Delayed TTL jobs, retries with backoff, idempotent `jobId`s |
| Hot state | Redis 7 + Lua | Atomic CAS so double-taps never double-resume an agent |
| Ledger | PostgreSQL 16 + Prisma | Append-only audit trail of who approved what, when |
| Telegram | grammY | Typed Bot API, webhook-friendly |
| Agents | REST + SSE + MCP | Cloud agents use webhooks; CLI agents use the MCP server |
| Observability | Pino + prom-client | Structured logs, latency histograms, queue outcome counters |

## Repository layout

```
apps/
  gateway-api/      Fastify REST API, Telegram webhook, SSE events, BullMQ producers
  worker-service/   BullMQ consumers: dispatch, TTL expiry, resolution, agent resume
  mcp-server/       MCP stdio server: ask_human_permission / notify_task-complete
packages/
  shared-types/     Zod schemas, Redis Lua CAS script, redaction, hashing, key layout
  sdk-ts/           TypeScript client for LangGraph / Vercel AI SDK integrations
prisma/             PostgreSQL audit ledger schema + migrations
docker-compose.yml  Postgres, Redis, gateway, worker, Caddy
```

## Quickstart (local dev)

Prereqs: Node 22+, a running PostgreSQL and Redis (or `docker compose up -d postgres redis`).

```bash
cp .env.example .env          # set TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_IDS, secrets
npm install
npm run db:generate
npm run db:deploy             # applies prisma/migrations
npm run build

npm run dev:gateway           # terminal 1 (port 3000)
npm run dev:worker            # terminal 2 (metrics on 9464)

# point the bot webhook at the gateway (uses PUBLIC_BASE_URL)
curl -X POST localhost:3000/v1/admin/telegram/set-webhook -H "x-api-key: dev-api-key"
```

Full stack with reverse proxy:

```bash
HITL_DOMAIN=hitl.example.com docker compose up -d --build
```

## API

All `/v1/*` routes require `x-api-key` when `GATEWAY_API_KEY` is set.

### Create an approval

```http
POST /v1/approvals
Idempotency semantics: same idempotencyKey returns the original request (and
re-enqueues dispatch for still-PENDING rows).
```

```json
{
  "idempotencyKey": "run-17-step-3",
  "agentId": "langgraph-demo",
  "threadId": "thread-42",
  "toolName": "transfer_funds",
  "toolArgs": { "amount": 500, "to": "acc_123", "password": "hunter2" },
  "reason": "Move treasury funds",
  "risk": "CRITICAL",
  "ttlSeconds": 900,
  "callbackUrl": "https://agent.example.com/webhooks/hitl-resume"
}
```

Response `201` (or `200` on idempotent replay):

```json
{
  "shortId": "SFpPr2luZK",
  "status": "PENDING",
  "toolArgsRedacted": { "amount": 500, "to": "acc_123", "password": "[REDACTED]" },
  "toolArgsHash": "5762ea10...",
  "expiresAt": "2026-10-15T17:51:09.675Z"
}
```

### Request kinds

`kind` selects the interaction shape (default `DECISION`):

| kind | Operator UI | Terminal status | `answer` shape |
| --- | --- | --- | --- |
| `DECISION` | ✅ / ❌ inline buttons | `APPROVED` / `DENIED` | `{type:"approval", decision}` |
| `CHOICE` | stacked inline option buttons under the request message | `ANSWERED` | `{type:"choice", optionId, label, index, followUpText?}` |
| `QUESTION` | operator replies in chat with the request ID tagged (`[shortId] …`) | `ANSWERED` | `{type:"text", text}` (JSON replies are redacted) |

Options may declare `followUpPrompt`: picking that option asks a follow-up question before the request resolves, and the final answer carries both the option and the typed follow-up text. Each message carries its own inline keyboard, so multiple concurrent requests stack cleanly in the chat and taps are correlated by the request ID embedded in the button's callback data — never by label text. Open-text answers (QUESTION and follow-ups) must be tagged with `[shortId]` (or `#shortId`); messages without a valid pending request ID are ignored.

```json
{
  "idempotencyKey": "deploy-17",
  "agentId": "langgraph-demo",
  "threadId": "thread-42",
  "toolName": "deploy_service",
  "kind": "CHOICE",
  "prompt": "Which environment should payments-api deploy to?",
  "options": [
    { "id": "staging", "label": "Staging (eu-west-1)" },
    { "id": "canary", "label": "Canary (10% traffic)" },
    { "id": "prod", "label": "Full production" }
  ],
  "risk": "CRITICAL",
  "ttlSeconds": 900
}
```

MCP: `ask_human_permission(tool_name, kind?, prompt?, options?, ...)` returns `{ status, answer, approved }` — `ANSWERED` counts as approved (`isError: false`) so the agent branches on `answer` instead of a boolean. Options support `follow_up_prompt` for open-ended choices.

### Other endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/approvals/:shortId` | Current state (Redis hot state, DB fallback) |
| GET | `/v1/approvals?threadId=&agentId=&status=` | List recent requests |
| GET | `/v1/approvals/:shortId/events` | SSE stream; first event is current state, then the terminal event |
| POST | `/v1/approvals/:shortId/cancel` | Agent-side abort (atomic CANCELLED transition) |
| POST | `/v1/webhooks/telegram` | Telegram callback receiver (`X-Telegram-Bot-Api-Secret-Token`) |
| POST | `/v1/admin/telegram/set-webhook` | Registers the bot webhook with the secret token |
| POST | `/v1/notifications/task-complete` | Agent completion notifications (MCP `notify_task_complete`) |
| POST | `/v1/notifications/agent-message` | Agent progress push to Telegram (remote mode) |
| POST | `/v1/admin/remote-mode` | Remote mode toggle (PC-trigger; spawns a Telegram session) |
| GET | `/v1/admin/remote-mode` | Remote mode state snapshot |
| GET | `/v1/remote/messages?agentId=&threadId=&since=` | Recent operator steering directives (for MCP agents) |
| GET | `/v1/remote/callback-url/:agentId` | Most recent resume `callbackUrl` registered by an agent |
| GET | `/healthz`, `/metrics` | Liveness + Prometheus metrics |

## Remote mode

Remote mode turns the Telegram bot into the agent's operator console: trigger it from the PC, unbind
from the laptop, and keep steering the agent over the bot until you explicitly turn it off.

```http
POST /v1/admin/remote-mode
x-api-key: <gateway api key>

{
  "enabled": true,
  "agentId": "claude-code",
  "threadId": "thread-42",
  "chatId": "-1001234567890",
  "spawnTopic": true,
  "callbackUrl": "https://agent.example.com/webhooks/hitl-resume",
  "reason": "going for a run"
}
```

- **Session spawn.** Enabling binds an agent session (`agentId` + optional `threadId`) to the Telegram chat (`chatId`, default: `DEFAULT_TELEGRAM_CHAT_ID`) and pushes a `🛰 Remote mode ON` notice. Disabling routes back to normal and stamps `disabledAt`. The flag persists for 24h max (`hitl:remote` Redis hash) — a dead-man switch so remote mode can never silently outlive you; re-trigger to extend.
- **Forum-topic sessions (v2).** Pass `topicId` to bind an existing Telegram forum topic, or `spawnTopic: true` and the gateway reuses or creates one for the session: the topic is named after `sessionName` when supplied (`{agentId} · {threadId}` otherwise), and re-enabling the same `(agentId, threadId)` **reopens the previous topic** for continuity (a stale/deleted topic falls back to fresh creation; `forceNewTopic: true` always spawns a clean one). With a topic bound, every outbound message (progress pushes and pending approvals) lands **in that topic**, operator replies in-topic steer that session (resolved via the `hitl:remote:topicmap:{chatId}:{topicId}` hash, falling back to the global flag binding for DM steering), and disabling remote mode closes the topic and marks the session registry `CLOSED`. Requirements: the bound chat must be a topics-enabled supergroup and the bot a member with **Manage Topics** (admin bots also bypass privacy mode, so steering reaches the webhook). If the binding chat is an ordinary DM or a topics-disabled group, omit both fields and v1 behavior applies: everything flows to the main chat.
- **Outbound: agent responses → bot.** While enabled, agents call MCP `send_operator_message(message, thread_id?)` (or `POST /v1/notifications/agent-message`) and the gateway enqueues `hitl-telegram-outbound`, which the worker delivers to the bound chat (and topic, when one is bound). When remote mode is off the same call acks `{ delivered: false, reason: "remote_mode_off" }` — no accidental routing.
- **Inbound: operator steering → agent.** Any non-tagged text message from an allowed operator while remote mode is on becomes a directive: the gateway persists an `operator_message` row (`kind=QUESTION`, `status=ANSWERED`) in the ledger and enqueues the signed `resume` callback so webhook agents receive the instruction. Agents running on stdio (Claude Code / OpenCode) pull them via MCP `check_operator_messages` or `GET /v1/remote/messages`. Tagged messages (`[shortId] …`) keep answering pending approvals as usual.
- **TTL hold.** While remote mode is active, the TTL worker postpones expiry (re-check every `REMOTE_TTL_RECHECK_SECONDS`) instead of firing the dead-man's switch — an unanswered approval during your run doesn't auto-deny. Switching remote mode off resumes normal expiry within one re-check.
- **Failure visibility.** The toggle self-probes `PUBLIC_BASE_URL/healthz` and warns (API response + Telegram) when the webhook is unreachable; steering typed in an unbound topic replies with which topic is actually live; duplicate steering deliveries collapse via a partial unique index; and the silent 24h flag expiry closes the session topic instead of leaving you typing into a void.
- **Permissions stay gated.** Remote mode changes the channel, never the security model: approve/deny still flows through the Redis CAS, the approver list, shared-secret webhooks, HMAC-signed resumes, and the runbook toolargs hash re-check.


### Resume callback

When the operator resolves a request, the gateway enqueues a resume job that POSTs to your `callbackUrl`:

```json
{
  "shortId": "SFpPr2luZK",
  "status": "APPROVED",
  "agentId": "langgraph-demo",
  "threadId": "thread-42",
  "toolName": "transfer_funds",
  "toolArgsHash": "5762ea10...",
  "resolvedBy": "123456789",
  "resolvedByUsername": "eyu",
  "resolvedAt": "2026-10-15T17:49:09.810Z"
}
```

Headers: `x-hitl-signature: sha256=<hmac>` (HMAC-SHA256 of the raw body with `HMAC_SECRET`) and `idempotency-key: hitl-resume:<shortId>`.

Verify with the SDK:

```ts
import { HitlClient } from "@hitl/sdk";

const ok = HitlClient.verify(rawBody, request.headers["x-hitl-signature"], secret);
```

Before resuming execution, re-hash the arguments you are about to run and compare against `toolArgsHash` — this defeats tampering between pause and resume.

## MCP integration (Claude Code / OpenCode / Cursor)

```json
{
  "mcpServers": {
    "hitl": {
      "command": "node",
      "args": ["/path/to/agent-hitl-telegram/apps/mcp-server/dist/index.js"],
      "env": {
        "GATEWAY_URL": "http://localhost:3000",
        "GATEWAY_API_KEY": "dev-api-key",
        "HITL_AGENT_ID": "claude-code",
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

Tools exposed:

- `ask_human_permission(tool_name, reason?, payload?, thread_id?, risk?, ttl_seconds?)` — blocks until Telegram resolution (Redis pub/sub, poll fallback) and returns `{ status, approved, resolvedBy, ... }`. Non-APPROVED outcomes return `isError: true`.
- `notify_task_complete(summary, thread_id?)` — reports completion to the gateway.
- `send_operator_message(message, thread_id?)` — pushes an interim update to the Telegram chat while remote mode is on (`{ delivered; reason? }` otherwise).
- `check_operator_messages(thread_id?, since?, limit?)` — pulls recent operator steering directives sent over Telegram during a remote session.

## TypeScript SDK

```ts
import { HitlClient } from "@hitl/sdk";

const client = new HitlClient({ baseUrl: "http://localhost:3000", apiKey: "dev-api-key" });

const pending = await client.createApproval({
  idempotencyKey: crypto.randomUUID(),
  agentId: "langgraph-demo",
  threadId: threadId,
  toolName: "execute_sql",
  toolArgs: { statement: "DROP TABLE users" },
  risk: "CRITICAL",
  ttlSeconds: 600,
});

const resolved = await client.waitForResolution(pending.shortId); // SSE, polling fallback
if (resolved.status !== "APPROVED") throw new Error(`Denied: ${resolved.status}`);
```

## Correctness & security properties

- **Exactly-once resolution.** A Redis Lua CAS script (`packages/shared-types/src/lua.ts`) transitions `PENDING → APPROVED|DENIED|EXPIRED|CANCELLED` atomically. Concurrent Telegram double-taps, TTL races, and agent cancels all funnel through the same guard; losers observe `ALREADY_RESOLVED` and no-op.
- **Dead-man's switch.** A delayed BullMQ job expires the request, strips the inline buttons (no stale 2 AM approvals at 8 AM), and emits `EXPIRED`.
- **Argument integrity.** `tool_args_hash = sha256(canonicalJson(args))` plus a redacted copy for the Telegram UI. Secrets matching `password|secret|token|api_key|authorization|cvv|...` are masked before they reach Telegram.
- **Webhook authenticity.** Inbound: constant-time check of `X-Telegram-Bot-Api-Secret-Token` + approver ID whitelist. Outbound: HMAC-signed resume payloads.
- **Idempotency.** Unique `idempotency_key` in the ledger; BullMQ `jobId`s contain no `:` (BullMQ constraint) and dedupe dispatch/TTL/resolution/resume work.
- **Fail closed.** Missing Redis state → `NOT_FOUND`; expired → no buttons; unauthorized actor → callback alert, no state change.

## Operations

- Gateway metrics: `hitl_approvals_created_total`, `hitl_telegram_webhook_outcomes_total`, `hitl_http_request_duration_seconds`.
- Worker metrics (port `9464`): `hitl_approvals_resolved_total{status}`, `hitl_approval_resolution_seconds`, `hitl_dispatch_duration_seconds`, `hitl_resume_deliveries_total{outcome}`.
- Graceful shutdown on SIGTERM/SIGINT drains workers and closes queues.

## Development

```bash
npm run typecheck     # tsc -b across the workspace
npm run build         # emit dist/ for all packages
npm run db:studio     # inspect the ledger
```

## Notes / trade-offs

- Telegram messages use plain text (no Markdown parse mode) so arbitrary tool arguments can never break entity parsing.
- The Prisma schema keeps a plain `(status, expires_at)` index instead of the partial `WHERE status = 'PENDING'` index — Prisma cannot declare partial indexes; add one via a custom migration if your pending volume demands it.
- Redis hot state TTLs at `ttl + 300s` (plus a 24h keep-alive after resolution) so late SSE clients and callbacks can still resolve.
