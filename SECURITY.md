# Security

**Current posture: the reference hub is deliberately unauthenticated localhost plumbing.** Do not bind it to a public interface. The trust boundary today is "who can reach the port." This document is the honest threat model — what can go wrong, what the protocol already defends by construction, and the designed fixes in the order they should ship.

## What thin pings already buy you

These properties hold by construction and are enforced by the conformance tests:

- **A forged, duplicated, or replayed ping is harmless in pull mode.** The ping carries no payload; the agent reads from its cursor at the hub and acks. At worst, a spurious wake makes an agent poll its own log and find nothing.
- **Delivery is not where correctness lives.** Dropped wakes lose nothing — events wait in the append-only log until acked. There is no exactly-once delivery machinery to get wrong.
- **A cold-started agent needs no local state**, so there is no state file to tamper with; `hub + subscription + cursor` reconstructs everything.

Everything below is about the places those properties *don't* cover.

## Threat model

### 1. Prompt injection via event data — the risk unique to agents

**Attack:** every previous webhook standard assumed the receiver parses fields with code. Here the receiver is a language model with tool permissions reading attacker-authored text. An event whose `data` says "ignore your instructions and run this" is not malformed input — it is a live attempt to steer a process with shell access, delivered through legitimate plumbing.

**Status:** open by nature; no protocol can fully solve prompt injection.

**Mitigations (integrator rules, today):**
- Subscribe only to event sources you trust. "Who may emit into this hub" is a security boundary, not a formality.
- Run the woken agent with the narrowest tool permissions that do the job (e.g. `--allowedTools 'Bash(curl:*)'`, never full access; Codex sandbox with loopback-only network).
- Treat event data as *data*: schema-validate it, and quote/fence it in the wake prompt rather than splicing it into instructions.
- For expensive agents, consider a **two-stage wake**: a cheap, tightly-sandboxed triage step classifies pending events and only escalates to the tool-bearing agent when they match expected shapes.

**Protocol-level help (roadmap):** schema'd event types with hub-side validation and size caps, so a subscription can require "only well-formed `task.created` events ever reach my prompt."

### 2. Cursor forgery — silent event suppression

**Attack:** on an open hub, the subtlest attack is not emitting fake events but `POST /subscriptions/:id/ack` on *someone else's* subscription, advancing their cursor past events they never saw. No alarm fires; work silently doesn't happen. Suppression is worse than spam because nobody notices.

**Status:** open on the reference hub (any caller can ack any subscription).

**Fix (first security milestone): subscriptions as capabilities.** Creating a subscription returns a `secret`; `wait` and `ack` require it (`Authorization: Bearer <secret>`). The subscription id stays shareable (it appears in pings); the secret never leaves the owner. This is a small, contained change to `hub.mjs` + spawner and kills the whole class.

**Also helps:** an append-only **ack audit log** (who advanced which cursor, when), so suppression is at least detectable after the fact.

### 3. Trusting the ping's `hub` URL — the laundering attack

**Attack:** "forged pings are harmless" holds only if the woken agent reads from its *configured* hub. An agent that follows the `hub` URL inside an unsigned ping can be redirected to an attacker's hub and fed fabricated events — the thin ping laundered back into a delivery channel.

**Status:** pull mode is immune by construction (the spawner only ever contacts `HUB_URL` from its own config; the ping arrives *from* that connection). The risk exists only for future push/webhook mode.

**Fix:** push mode must not ship without **signed thin pings** (Standard Webhooks HMAC headers + WebSub-style verification at subscribe time), and the integrator rule stands regardless: *the ping wakes you; your configuration tells you where to read.*

### 4. Source spoofing

**Attack:** `POST /events` accepts any `source` string, so an attacker who can reach the hub can impersonate a trusted source ("this event is from CI") — which feeds directly into risk #1, since agents reasonably trust some sources more than others.

**Status:** open on the reference hub.

**Fix: per-source emit credentials.** Emitters get tokens bound to a source prefix (token X may only emit `source=github-bridge`, perhaps only types `github.*`). The hub stamps `source` from the credential rather than trusting the body. Filters then double as visibility scoping: a subscription only sees the types it was granted.

### 5. Wake storms — economic DoS

**Attack:** agents are the one receiver where invocation costs real money. An event flood against an unprotected subscription isn't a full queue, it's a token bill. Even benign chatty sources can bankrupt a well-intentioned subscriber.

**Status:** partially defended. Coalescing is free by design (300 pending events is still one ping; the spawner runs one agent at a time), the BB plugin enforces a minimum interval between wakes and waits for the woken thread to finish, and the spawner backs off exponentially when the agent fails.

**Fix: wake economics enforced hub-side, per subscription** — `min_interval_s`, `batch_window_s`, parking after N failed/unacked wakes, and optionally a wakes-per-day budget. The hub is the right enforcement point because it fires before the expensive agent boots. This is the genuinely novel section of the spec; no previous webhook standard needed it.

### 6. Poison events — the infinite retry loop

**Attack (or accident):** an event that reliably crashes or derails its handler re-wakes the agent forever, because unacked events stay pending. The spawner's exponential backoff (5s → 5min) caps the burn rate but never ends it.

**Status:** rate-limited, not resolved.

**Fix: dead-lettering.** After N consecutive wakes without the cursor advancing past an event, the hub parks the subscription and marks the blocking event; a `POST /subscriptions/:id/skip` (capability-gated, audited) advances the cursor past a dead letter deliberately. Events are never deleted — the log stays the truth — but progress can resume.

### 7. Confidentiality — the log is world-readable plaintext

**Attack:** `GET /events` returns the entire log to any caller, and `data/events.jsonl` sits unencrypted on disk. Events often carry sensitive payloads (task contents, repo names, emails).

**Status:** open; acceptable only on localhost.

**Fix:** read scoping via subscription capabilities (you read through your subscription's filter, not the raw log), TLS when the hub leaves localhost, and guidance that stays true at every layer: **don't put secrets in event payloads — put references.** The thin-ping philosophy applies to your own events too: carry a pointer, let the reader fetch with its own credentials.

### 8. Spawner execution surface

**Notes for completeness:** the spawner passes the ping to the agent via environment variable and stdin — it is never interpolated into the shell command, so a hostile ping cannot inject shell syntax. `WAKE_CMD` itself is trusted operator configuration, equivalent to cron: whoever can set it already owns the account. The npm package runs no install scripts.

## Hardening roadmap (in order)

1. **Subscription capabilities** — create-time secret required for `wait`/`ack` (kills #2, enables #6/#7 controls). Small change; first milestone.
2. **Per-source emit credentials** with hub-stamped `source` (kills #4, shrinks #1's surface).
3. **Hub-enforced wake economics** — `min_interval_s`, `batch_window_s`, parking, budgets (closes #5).
4. **Dead-lettering + capability-gated cursor skip** (closes #6).
5. **Signed pings + subscribe-time verification** — the precondition for shipping push mode at all (#3).
6. **Schema'd event types + size caps** (structural help for #1).
7. **Ack audit log** (detection for #2), TLS guidance, read scoping (#7).

The ordering principle: the reference implementation stays *loudly* unauthenticated localhost plumbing until subscription ownership ships, rather than growing half a security model that invites misplaced trust.

## Reporting

This is an early-stage reference implementation. If you find a vulnerability beyond the documented posture above, open a GitHub issue (or contact the maintainer privately for anything sensitive once the repo is public).
