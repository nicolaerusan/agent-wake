# agent-wake

A vendor-neutral standard (and reference implementation) for **waking agents from events**: agent webhooks, subscriptions, triggers, and event hubs.

Push vs pull agents, unified: events live in a durable append-only hub; agents hold subscriptions with **cursors**; wakes are **thin pings** ("something's waiting"), never payloads. Push is a latency optimization over pull — polling a cursor is always a valid fallback, so delivery needs no exactly-once machinery.

Landing page: https://nicolaerusan.github.io/agent-wake/ · Companion essay: *Push vs Pull Agents, and the Case for a Wake Standard* (nicolaerusan.com/writing/push-vs-pull-agents).

## The three primitives

- **Hub** — append-only log of typed events (CloudEvents-ish envelope), stable IDs, per-stream order.
- **Subscription** — filter + delivery target + cursor + wake economics (`min_interval_s`, `batch_window_s`, parking).
- **Thin ping** — `{hub, subscription, cursor, pending}`. The agent reads events after its cursor from the hub and acks.

Two delivery modes over one model:

- `poll` (mandatory): long-poll mailbox — `GET /subscriptions/:id/wait`. NAT-proof, no public URL needed.
- `webhook` (optimization): signed thin ping, Standard-Webhooks headers, WebSub-style verification.

The wake target is a *spawner*, not a process: a cold-started agent reconstructs everything from hub + subscription + cursor.

## Install (one line, zero dependencies, Node ≥20)

```sh
npm install -g github:nicolaerusan/agent-wake     # or npx github:nicolaerusan/agent-wake <cmd>
```

## Quickstart

Three terminals — hub, watcher, and you playing the world:

```sh
# 1. the hub — durable event log + subscriptions + mailbox
agent-wake hub                          # http://localhost:7777, data/ for state

# 2. the watcher — wakes an agent CLI on every event (subscription auto-created)
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

## Prior art we steal from

CloudEvents (envelope) · Standard Webhooks (signing/retries) · WebSub (subscribe/verify/deliver) · ActivityPub (inbox as identity) · SMTP/MX (addressability standardized, hosting not).
