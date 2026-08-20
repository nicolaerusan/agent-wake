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

**Fix (first security milestone): subscriptions as capabilities.** Creating a subscription returns a high-entropy bearer token; subscription status, filtered reads, `wait`, and `ack` require it. The subscription id stays shareable and is only an address. The token grants authority over one subscription, not the whole hub.

Authentication is necessary but not sufficient. The current `ack` implementation accepts malformed and future cursors. The hub must require a safe integer, monotonic progress, a cursor no later than the current or delivered bound, and preferably a cursor corresponding to a matching delivered event. A deliberate bypass belongs in a separate audited `skip` operation. Otherwise, a buggy or prompt-injected *authorized* agent can still suppress current or future work.

**Also helps:** an append-only **ack audit log** (who advanced which cursor, when), so suppression is at least detectable after the fact.

### 3. Trusting the ping's `hub` URL — the laundering attack

**Attack:** "forged pings are harmless" holds only if the woken agent reads from its *configured* hub. An agent that follows the `hub` URL inside an unsigned ping can be redirected to an attacker's hub and fed fabricated events — the thin ping laundered back into a delivery channel.

**Status:** pull mode obtains its ping through the spawner's configured `HUB_URL`, which is a strong starting point, but the child prompts currently follow the `hub` field returned inside that ping. The spawner should validate or replace the ping's hub and subscription fields before starting the child. Future push/webhook delivery also needs signed pings.

**Fix:** the wake watcher is the trust anchor: *the doorbell wakes you; configuration tells you where to read.* Push mode must not ship without **signed thin pings** (Standard Webhooks HMAC headers + WebSub-style verification at subscribe time).

### 4. Source spoofing

**Attack:** `POST /events` accepts any `source` string, so an attacker who can reach the hub can impersonate a trusted source ("this event is from CI") — which feeds directly into risk #1, since agents reasonably trust some sources more than others.

**Status:** open on the reference hub.

**Fix: per-source emit credentials.** Emitters get tokens bound to a source and permitted event types (token X may emit as `github-bridge`, perhaps only types `github.*`). The hub stamps `source` from the credential rather than trusting the body. Provenance is not content safety: an authenticated GitHub bridge can still faithfully relay attacker-authored issue text.

### 5. Wake storms — economic DoS

**Attack:** agents are the one receiver where invocation costs real money. An event flood against an unprotected subscription isn't a full queue, it's a token bill. Even benign chatty sources can bankrupt a well-intentioned subscriber.

**Status:** partially defended. Coalescing is free by design (300 pending events is still one ping; the spawner runs one agent at a time), the BB plugin enforces a minimum interval between wakes and waits for the woken thread to finish, and the spawner backs off exponentially when the agent fails.

A CLI agent that exits successfully without advancing the cursor is currently woken again immediately. Exit status alone is not progress.

**Fix: wake economics enforced hub-side, per subscription** — `min_interval_s`, `batch_window_s`, parking after N failed/unacked wakes, and optionally a wakes-per-day budget. The hub is the right enforcement point because it fires before the expensive agent boots. This is the genuinely novel section of the spec; no previous webhook standard needed it.

### 6. Poison events — the infinite retry loop

**Attack (or accident):** an event that reliably crashes or derails its handler re-wakes the agent forever, because unacked events stay pending. The spawner's exponential backoff (5s → 5min) caps the burn rate but never ends it.

**Status:** rate-limited, not resolved.

**Fix: dead-lettering.** After N consecutive wakes without the cursor advancing past an event, the hub parks the subscription and marks the blocking event; a `POST /subscriptions/:id/skip` (capability-gated, audited) advances the cursor past a dead letter deliberately. Events are never deleted — the log stays the truth — but progress can resume.

### 7. Confidentiality — the log is world-readable plaintext

**Attack:** `GET /events` returns the entire log to any caller, and `data/events.jsonl` sits unencrypted on disk. Events often carry sensitive payloads (task contents, repo names, emails).

**Status:** open; acceptable only on localhost.

**Fix:** read through a subscription-native endpoint such as `GET /subscriptions/:id/events`, requiring the subscription capability and applying its stored filter server-side. Today filters gate wakes but the example agents and generated prompts fetch the global log without applying the subscription filter, so filters are not yet an integrity or confidentiality boundary. The raw log should be disabled or operator-only outside explicit local debugging.

Use TLS when the hub leaves localhost, and follow guidance that stays true at every layer: **don't put secrets in event payloads — put references.** This is data minimization, not complete confidentiality: repository names, customer IDs, URLs, timing, and topology can still be sensitive, and a signed URL is itself a secret.

### 8. Spawner execution surface

**Notes for completeness:** the spawner passes the ping to the agent via environment variable and stdin — it is never interpolated into the shell command, so a hostile ping cannot inject shell syntax. `WAKE_CMD` itself is trusted operator configuration, equivalent to cron: whoever can set it already owns the account. The npm package runs no install scripts.

### 9. At-least-once processing and duplicate side effects

**Risk:** an agent performs an external write, then crashes before acknowledging its event. The event remains pending and the write may happen again on retry.

**Status:** this is inherent in any cursor protocol that cannot share a transaction with every destination system. The current successful-path tests demonstrate ordered cursor progress, not exactly-once external effects.

**Mitigation:** specify at-least-once processing. Give every event a stable id and require consumers to use it as an idempotency key, keep a destination-side receipt, or inspect whether an intended external effect already happened before repeating it.

## The two components that face outward

The hub is localhost plumbing. Two optional pieces are designed to sit
between it and everything else, and their security properties are worth
stating separately.

### `agent-wake ingest` — the webhook bridge

This is what an external system should POST to, never the hub. It exists so
that "who may emit into this inbox" is an enforced boundary rather than a
convention.

**What it enforces today:** a shared token (header or query parameter,
compared in constant time) for `/hook/<name>`; HMAC-SHA256 verification of
`X-Hub-Signature-256` over the exact received bytes for `/github`; refusal to
start with no credentials configured; a 256KB body cap; localhost binding
unless `--bind` is passed explicitly. Crucially, **the caller cannot name
itself**: `type` and `source` are derived from the authenticated route and
sanitized, so a body claiming `source: github` is ignored. This closes risk
#4 for events that arrive through the bridge.

**What it does not do yet:** no per-sender rate limiting (wake economics
still belong hub-side, risk #5), no replay protection or delivery-id
deduplication (a captured signed GitHub delivery can be replayed; the cursor
model makes that harmless to *correctness*, but it still costs a wake), no
TLS of its own — terminate it in front if you expose it. And provenance is
not content safety: a correctly signed GitHub delivery still carries text an
attacker wrote, which is risk #1 unchanged.

### `agent-wake mcp` — read-first access for agents

An MCP server that lets an assistant you are already talking to scan the
inbox without waking anything. It is deliberately ordered by authority:
reads are always available, `wake_emit_event` is on by default and removed by
`--read-only`, and `wake_ack` is **off** unless `--allow-ack` — because
advancing a cursor is the one operation that silently destroys work
(risk #2), and an MCP-connected model reading attacker-authored event text is
exactly the case where that matters.

Every tool that returns event bodies states in its own description that event
data is untrusted input to reason about, never instructions to follow. That
is a mitigation, not a solution; risk #1 stands.

## Security is layered

The hub decides **what may wake, what may be read, and how often a run may start**. The agent runner or hosted agent service decides **what that run may do**. A production integration should combine:

- a filesystem sandbox limited to the intended checkout or disposable worktree;
- network disabled or restricted to explicit destinations;
- a deny-by-default tool surface and scoped external-service credentials;
- human approval for publishing, merging, deleting, deploying, or spending;
- runtime, token, concurrency, and daily cost limits; and
- audit records for wakes, cursor changes, approvals, and external writes.

Codex local agents support filesystem sandboxing, approval policies, and network controls; Codex cloud uses isolated containers with agent-phase internet off by default. Claude Code supports tool allow/ask/deny rules plus filesystem and network sandboxing. These provider controls reduce the effect of prompt injection, but do not replace source authentication, filtered reads, progress validation, or wake budgets in the hub. See [the concrete architecture guide](ARCHITECTURE.md#what-restrictions-can-an-agent-service-add) for deployment examples and official product documentation.

## Hardening roadmap (in order)

1. **Adversarial conformance tests and honest semantics** — filtered-read isolation, malformed/future ack rejection, unauthorized operations, crash-before-ack replay, simultaneous wakes, and exit-zero-without-progress. Specify at-least-once processing (#9).
2. **Subscription-native reads and capabilities** — a create-time token required for subscription status, filtered events, `wait`, and `ack`; strict cursor validation (#2/#7).
3. **Per-source emit credentials** with a hub-stamped source and event-type scope (#4).
4. **Hub-enforced wake economics** — `min_interval_s`, `batch_window_s`, no-progress detection, parking, and budgets (#5).
5. **Dead-lettering + separately authorized, audited cursor skip** (#6).
6. **Signed pings + subscribe-time verification** — the precondition for shipping push mode (#3).
7. **Schema'd event types + size caps** — deterministic structural help before optional model triage (#1).
8. **Ack audit log**, TLS guidance, credential rotation/revocation, and an operator-only raw-log path.

The ordering principle: the reference implementation stays *loudly* unauthenticated localhost plumbing until subscription ownership ships, rather than growing half a security model that invites misplaced trust.

## Reporting

This is an early-stage reference implementation. If you find a vulnerability beyond the documented posture above, open a GitHub issue (or contact the maintainer privately for anything sensitive once the repo is public).
