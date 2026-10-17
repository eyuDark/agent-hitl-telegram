# Local setup guide

Everything you need to run the HITL engine on your own machine and steer agents
from your phone through Telegram (remote mode).

```
agent (any project) ──MCP──▶ gateway API (:3100) ──▶ Telegram
                                   ▲    │
                     your phone ◀──┘    └──▶ worker (dispatch / TTL / resume)
                approvals, steering              Redis (state + queues)
              coming back over topics            Postgres (ledger)
```

## Prerequisites

- Node.js 20+
- Docker Desktop (containers `hitl-postgres` on :5433, `hitl-redis` on :6380)
- A Telegram account
- `cloudflared` (optional, only if you want Telegram inbound from outside — `brew install cloudflared`)

## 1. Telegram side (10 minutes)

1. **Create the bot**: message [@BotFather](https://t.me/BotFather) → `/newbot` → save
   the token (`123456789:AA...`).
2. **Get your Telegram id**: message [@userinfobot](https://t.me/userinfobot) → note the id.
3. **Create the companion chat** (one of):
   - plain private chat with the bot — zero setup, fine for DM fallback
   - a group → Edit → **enable Topics** (this converts it to a supergroup and
     **changes the chat id** — grab the new id after upgrading, see Troubleshooting) →
     add the bot as admin with **Manage Topics** + **Invite Users**.
4. Optional but recommended: jump into the bot's chat and send `/start` so Telegram
   shows the bot's message history cleanly.

## 2. Run the stack

```bash
git clone https://github.com/eyuDark/agent-hitl-telegram.git
cd agent-hitl-telegram
cp .env.example .env
```

Edit `.env`:

| Var | What |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | any random string; also goes into the webhook registration |
| `ALLOWED_TELEGRAM_IDS` | comma-separated ids of operators allowed to approve/steer |
| `DEFAULT_TELEGRAM_CHAT_ID` | where approvals land with no explicit chat (your id, or the group id) |
| `GATEWAY_API_KEY` | the key MCP/agents must send as `x-api-key` (default `dev-api-key`) |
| `PUBLIC_BASE_URL` | where Telegram can reach the webhook — only needed for remote/inbound (see §3) |
| `HMAC_SECRET` | signs resume callbacks to agents |

Then:

```bash
./start.sh
```

That creates/starts both containers, builds the monorepo, applies Prisma migrations,
and launches:

- gateway API on **:3100** (`GET /healthz`, logs in `logs/gateway.log`)
- worker metrics on **:9464** (logs in `logs/worker.log`)

## 3. Public URL + webhook (remote mode only)

Inbound Telegram traffic (approve/deny taps, in-topic steering) needs a webhook the
Telegram cloud can POST into. The gateway registers it at boot from `PUBLIC_BASE_URL`,
so point that anywhere reachable:

```bash
cloudflared tunnel --url http://localhost:3100
# prints https://something.trycloudflare.com
```

Set `PUBLIC_BASE_URL` to that URL and restart the gateway (`./start.sh` again — it
re-registers the webhook). Quick tunnels rotate their URL on every restart, so
re-do these two steps each time; for a stable setup use a named cloudflare tunnel
or a real domain.

Local-only usage without any public host is not possible for inbound traffic:
approvals and steering arrive as Telegram messages, and Telegram delivers those via
webhook — so `PUBLIC_BASE_URL` must point at an HTTPS host reachable from the
internet. DM-only answering from a phone still requires it.

## 4. Wire an agent

### Claude Code (or any MCP client)

```bash
claude mcp add hitl -s user \
  -e GATEWAY_URL=http://localhost:3100 \
  -e GATEWAY_API_KEY=dev-api-key \
  -- node /path/to/agent-hitl-telegram/apps/mcp-server/dist/index.js
```

The agent needs zero knowledge of this repo — it gets four tools:
`ask_human_permission` (blocks until you tap or TTL expires), `notify_task_complete`,
`send_operator_message`, `check_operator_messages`. If you want the behavior
guaranteed, add one line to the project's `CLAUDE.md` like
`use the hitl MCP ask_human_permission tool before anything destructive`.

### Server agents (LangGraph, custom webhooks)

Pass a `callbackUrl` per approval; the gateway POSTs a signed resume payload when
the operator resolves the request. Same REST API otherwise (`POST /v1/approvals`).

### CLI agents on an unattended PC (push into the loop)

CLI agents are eventless — they sleep between turns. To get Telegram steering
delivered *to the agent itself* while you are away, run the session under tmux:

```bash
tmux new -s hitl   # then start the agent inside (e.g. opencode / claude)
```

The local watchdog probes steering every ~10s and, when the agent is dormant,
injects the sweep prompt directly into that tmux pane (`tmux send-keys`) — the
agent wakes, swallows everything queued in `steering-live.log`, and answers back
through the outbound bridge. Without tmux the same watchdog still alarms the
Telegram topic (⏳ every 60s), but nobody can wake the agent until a human types
into its terminal.

## 5. First remote session

```bash
curl -X POST http://localhost:3100/v1/admin/remote-mode \
  -H "content-type: application/json" -H "x-api-key: dev-api-key" \
  -d '{"enabled":true,"agentId":"claude-code","threadId":"session-1","chatId":"<group-or-your-id>","spawnTopic":true,"sessionName":"project work"}'
```

- A forum topic named `project work` is created in the bound group (DM chat → no
  topic, everything flows to the main chat).
- Next enable for the same `(agentId, threadId)` **reopens that topic** instead of
  spawning a new one; add `forceNewTopic: true` for a clean slate.
- While ON: pending approvals go in-topic, agent pushes land in-topic, and any
  untagged text you type in the topic becomes a steering directive the agent picks
  up via `check_operator_messages`.
- While ON the TTL worker **postpones expiry** of pending approvals (re-check every
  `REMOTE_TTL_RECHECK_SECONDS`) — nothing auto-dies mid-session.
- Turn it off when done (`"enabled":false`): the topic closes itself, registry marks
  the session `CLOSED`. The flag also dies automatically after 24h (dead-man switch).

To just steer an already-running remote session from your phone, the MCP tool
`check_operator_messages` (or `GET /v1/remote/messages?agentId=&threadId=&since=`)
is the pull side; approve/deny taps flow through the inline buttons.

## 6. Operating notes

- Ports: gateway `:3100`, worker metrics `:9464`, Postgres `:5433`, Redis `:6380`.
- Containers are named `hitl-postgres` / `hitl-redis` and are safe to reuse across
  restarts (`docker start hitl-postgres hitl-redis`).
- Full API reference lives in the main `README.md`.
- Security model: `x-api-key` gates the API, the webhook checks its secret token,
  only `ALLOWED_TELEGRAM_IDS` can act on cards, and approvals are CAS-resolved in
  Redis — remote mode changes the channel, never the model.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `400: the chat is not a forum` on toggle | the group isn't Topics-enabled: Edit → Topics on |
| `group chat was upgraded to a supergroup chat` | enabling Topics migrated the chat; grab the **new** chat id (`getChat` via the bot API or a fresh group message) and rebind |
| steering replies never arrive | bot needs **Manage Topics** admin (also bypasses privacy mode so webhook sees group messages) |
| webhook returns 401 | `TELEGRAM_WEBHOOK_SECRET` mismatch between `.env` and the registered webhook |
| agent messages ack `remote_mode_off` | remote mode is off — the outbound bridge only delivers while ON |
| `chat not found` after id change | groups migrate to negative-13-digit ids once topics are on; re-query the chat |
