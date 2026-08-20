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
