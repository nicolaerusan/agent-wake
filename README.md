# agent-wake

A vendor-neutral standard (and reference implementation) for **waking agents from events**: agent webhooks, subscriptions, triggers, and event hubs.

Push vs pull agents, unified: events live in a durable append-only hub; agents hold subscriptions with **cursors**; wakes are **thin pings** ("something's waiting"), never payloads. Push is a latency optimization over pull — polling a cursor is always a valid fallback, so delivery needs no exactly-once machinery.

Landing page: https://nicolaerusan.github.io/agent-wake/ · Companion essay: *Push vs Pull Agents, and the Case for a Wake Standard* (nicolaerusan.com/writing/push-vs-pull-agents).

New to the terminology? [How agent-wake fits into the agents people use today](ARCHITECTURE.md)
explains the event inbox, wake watcher, and working agent with concrete Claude
Code, Codex, BB, desktop, and hosted examples.

Want to see it work first? [Try it in five minutes](TRY_IT.md), with no API key
or AI account required.

Exploring a shared service? [Global event bus, spaces, and agent publishing](GLOBAL_EVENT_BUS.md)
defines spaces as the security boundary, covers agent feedback loops, and maps
where an optional policy layer such as White Circle could fit.

## The three primitives

- **Event inbox (hub)** — append-only log of typed events (CloudEvents-ish envelope), stable IDs, per-stream order.
- **Wake rule and bookmark (subscription + cursor)** — filter + delivery target + progress + wake economics (`min_interval_s`, `batch_window_s`, parking).
- **Doorbell (thin ping)** — `{hub, subscription, cursor, pending}`. It only says work is waiting; the agent reads from the inbox and records progress.

Two delivery modes over one model:

- `poll` (mandatory): long-poll mailbox — `GET /subscriptions/:id/wait`. NAT-proof, no public URL needed.
- `webhook` (optimization): signed thin ping, Standard-Webhooks headers, WebSub-style verification.

The wake target is a **wake watcher** (called the spawner in the implementation),
not an already-running agent. The watcher is boring background plumbing that
starts a fresh working agent when the doorbell rings. See [the concrete deployment
guide](ARCHITECTURE.md) for local CLI, desktop, BB, and hosted arrangements.

## Install (one line, zero dependencies, Node ≥20)

```sh
npm install -g github:nicolaerusan/agent-wake     # or npx github:nicolaerusan/agent-wake <cmd>
```

## Quickstart

Three terminals — hub, watcher, and you playing the world:

```sh
# 1. the hub — durable event log + subscriptions + mailbox
agent-wake hub                          # http://localhost:7777, data/ for state

# 2. the watcher — start with the bundled visible demo (no AI account needed)
agent-wake watch --echo

# then try a real agent CLI (subscription auto-created)
agent-wake watch --claude               # wake Claude Code
agent-wake watch --codex                # ...or Codex
agent-wake watch --cmd 'node examples/echo-agent.mjs'   # ...or anything

# 3. emit an event — watch the agent cold-start, read, ack, exit
agent-wake emit task.created --data '{"title":"hello"}'
```

`watch --claude` / `--codex` shell out to `claude -p` / `codex exec` with a
standard wake prompt: read the thin ping from `$WAKE_PING`, fetch events
after your cursor from the hub, handle them, ack. Anything after `--` is
passed through to the agent CLI. Filter with `--types a,b`, reuse a
subscription with `--sub sub_x`, point elsewhere with `--hub URL`.

The raw pieces are still there for scripting: `node hub.mjs`, `node
spawner.mjs` (env-driven), plus `agent-wake sub` / `emit` / `events`.

## Receiving webhooks (events from the outside world)

The hub has no authentication, so it must never be the thing a stranger
POSTs to. `agent-wake ingest` is the piece that faces outward: it
authenticates the sender, decides the event type and source itself, and only
then writes into the hub.

```sh
agent-wake ingest --token hunter2                    # 127.0.0.1:7788 by default

curl -X POST localhost:7788/hook/ci \
  -H 'X-Wake-Token: hunter2' \
  -d '{"repo":"agent-wake","status":"failed"}'       # -> event hook.ci, source hook:ci
```

GitHub can deliver straight to it, proving itself with its own HMAC instead
of the shared token — point a repository webhook at `/github` with the same
secret:

```sh
agent-wake ingest --token hunter2 --github-secret "$GH_WEBHOOK_SECRET"
# POST /github  ->  event type github.<X-GitHub-Event>, source github
```

What the bridge guarantees, and what it deliberately does not:

- **The caller cannot name itself.** `type` and `source` are derived from the
  authenticated route (`/hook/ci` → `hook.ci`, `source: hook:ci`), never read
  from the body, so nothing can claim to be `source: github`.
- **Unauthenticated requests never reach the hub** — no token, wrong token, or
  a bad GitHub signature is refused before any event is written.
- **It binds to localhost** unless you pass `--bind` explicitly. Exposing it
  (directly or through a tunnel) means accepting that whoever holds the token
  can wake your agents, so pair it with the wake economics you want.
- **Provenance is not content safety.** A correctly signed GitHub delivery
  still carries issue text an attacker wrote. See [SECURITY.md](SECURITY.md).

## Scanning events from any agent (MCP)

The read-only way to use agent-wake: no waking, no spawning, no standing
process. An assistant you are *already* talking to can look at what arrived.

```sh
agent-wake mcp --read-only     # stdio MCP server: scan events, never write
```

Register it once and ask questions like "what has come in since this
morning?" or "what is subscription sub_1jhe behind on?":

```sh
claude mcp add agent-wake -- agent-wake mcp --read-only
```

```jsonc
// Claude Desktop, Cursor, and friends: mcpServers config
{ "mcpServers": { "agent-wake": { "command": "agent-wake", "args": ["mcp", "--read-only"] } } }
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.agent_wake]
command = "agent-wake"
args = ["mcp", "--read-only"]
```

Tools, ordered by how much authority they need:

| Tool | Authority | What it does |
| --- | --- | --- |
| `wake_scan_events` | read | Recent events, filtered by type or source |
| `wake_pending` | read | What one subscription has not processed yet |
| `wake_list_subscriptions` | read | Every wake rule, its filter, cursor, and backlog |
| `wake_emit_event` | write (on by default; `--read-only` removes it) | Post a new event |
| `wake_ack` | **off** unless `--allow-ack` | Advance a cursor past handled events |

`wake_ack` is opt-in because advancing a cursor is the one operation that can
*silently* destroy work — the suppression risk in [SECURITY.md](SECURITY.md).
Every tool that returns event bodies tells the model, in its own description,
that event data is untrusted input to reason about rather than instructions
to follow.

## BB plugin

The repo doubles as a [bb](https://getbb.app) plugin collection —
`bb-plugin-agent-wake/` wakes BB threads instead of CLI processes: a
background service long-polls a subscription and spawns a thread per thin
ping, with your standing instructions in the prompt. Plus `bb wake emit` /
`bb wake status` and a skill teaching agents the ack protocol.

```sh
bb plugin install https://github.com/nicolaerusan/agent-wake --plugin agent-wake
```

Run the end-to-end tests (hub + spawner + real spawned agent processes, black-box over HTTP):

```sh
npm test
```

## MVP plan

1. `packages/hub` — one process, SQLite; `POST /events`, `GET /events?after=`, subscription CRUD, mailbox long-poll, ack.
2. `packages/push-worker` — signed thin-ping delivery: coalescing, min intervals, park-after-N-failures.
3. `packages/spawner` — ~50-line daemon: long-poll mailbox → shell out to an agent CLI with the ping.
4. `bridges/github` — one real event source (GitHub webhooks → hub) for the end-to-end demo.
5. `conformance/` — black-box tests that define "is a hub" / "is a wake target": cursor idempotency, duplicate-ping harmlessness, coalescing, parking, resume-after-a-week. The tests are the standard until the prose catches up.
6. `spec/` — the ~2 pages of normative text, drafted after the conformance suite forces precision.

Non-goals for the MVP: hub federation, discovery, payment, framework integrations beyond "spawn a CLI."

## Security posture (read before pointing this at anything real)

The reference hub is **deliberately unauthenticated localhost plumbing**. Do not bind it to the internet. The full threat model — including prompt injection, cursor suppression, filtered-read isolation, wake economics, and duplicate external effects — lives in [SECURITY.md](SECURITY.md). The short version:

- **Anyone who can reach the hub can do anything**: emit events (with any spoofed `source`), read the whole log, create subscriptions, and — subtlest — **ack someone else's cursor forward, silently suppressing their events**. Subscription ownership (create-time secrets, per-source emit credentials) is the first post-MVP security milestone; until then, the trust boundary is "who can reach the port."
- **Event data is prompt-injection surface.** A woken agent reads attacker-authored `data` inside a reasoning loop that has tools. Only subscribe to event sources you trust, and give the woken agent the narrowest permissions that do the job (e.g. `--allowedTools 'Bash(curl:*)'`, not full access).
- **Never trust the ping — including its `hub` URL.** "Forged pings are harmless" only holds if the agent reads from its *configured* event inbox. The wake watcher must validate or replace the ping context before starting the child; push mode additionally requires signed pings before it ships.
- **Wake economics are the DoS defense**: min intervals, coalescing, and parking keep an event flood from becoming a token bill. The spawner backs off exponentially when the agent fails, but a poison event still re-wakes until acked or skipped — dead-lettering is on the roadmap.
- **Processing is at least once.** If an agent completes an external write and crashes before recording progress, the event is delivered again. Consumers must make side effects idempotent using the stable event ID or destination-side checks.

## Prior art we steal from

CloudEvents (envelope) · Standard Webhooks (signing/retries) · WebSub (subscribe/verify/deliver) · ActivityPub (inbox as identity) · SMTP/MX (addressability standardized, hosting not).
