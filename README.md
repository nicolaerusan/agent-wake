# agent-wake

A vendor-neutral standard (and reference implementation) for **waking agents from events**: agent webhooks, subscriptions, triggers, and event hubs.

Push vs pull agents, unified: events live in a durable append-only hub; agents hold subscriptions with **cursors**; wakes are **thin pings** ("something's waiting"), never payloads. Push is a latency optimization over pull — polling a cursor is always a valid fallback, so delivery needs no exactly-once machinery.

Companion essay: *Push vs Pull Agents, and the Case for a Wake Standard* (nicolaerusan.com/writing/push-vs-pull-agents).

## The three primitives

- **Hub** — append-only log of typed events (CloudEvents-ish envelope), stable IDs, per-stream order.
- **Subscription** — filter + delivery target + cursor + wake economics (`min_interval_s`, `batch_window_s`, parking).
- **Thin ping** — `{hub, subscription, cursor, pending}`. The agent reads events after its cursor from the hub and acks.

Two delivery modes over one model:

- `poll` (mandatory): long-poll mailbox — `GET /subscriptions/:id/wait`. NAT-proof, no public URL needed.
- `webhook` (optimization): signed thin ping, Standard-Webhooks headers, WebSub-style verification.

The wake target is a *spawner*, not a process: a cold-started agent reconstructs everything from hub + subscription + cursor.

## Quickstart (runs locally, zero dependencies, Node ≥20)

Three terminals — hub, spawner, and you playing the world:

```sh
# 1. the hub — durable event log + subscriptions + mailbox
node hub.mjs                            # http://localhost:7777, data/ for state

# 2. register a subscription, start the spawner (the tiny always-on shim)
SUB=$(curl -s -X POST localhost:7777/subscriptions -d '{}' | jq -r .id)
HUB_URL=http://localhost:7777 SUB_ID=$SUB \
  WAKE_CMD='node examples/echo-agent.mjs' node spawner.mjs

# 3. emit an event — watch the agent cold-start, read, ack, exit
curl -X POST localhost:7777/events -d '{"type":"task.created","data":{"title":"hello"}}'
```

To wake a real agent instead of the echo demo, change one string:

```sh
WAKE_CMD='claude -p "You were woken. Ping in $WAKE_PING — read your pending events from the hub, handle them, ack your cursor."'
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
