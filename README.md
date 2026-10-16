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
| GET | `/healthz`, `/metrics` | Liveness + Prometheus metrics |

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
