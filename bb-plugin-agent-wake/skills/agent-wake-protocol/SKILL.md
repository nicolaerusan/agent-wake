---
name: agent-wake-protocol
description: How to handle an agent-wake ping — read pending events from the hub after your cursor, handle them, and ack. Use when a prompt mentions being "woken", a "thin ping", a WAKE_PING value, or an agent-wake hub/subscription/cursor.
---

# Handling an agent-wake ping

A thin ping is `{hub, subscription, cursor, pending}` — it carries no event
payloads. The hub's cursor is the truth: a stale or duplicate ping is
harmless because you always re-read your real cursor before acting.

Steps (all plain HTTP, use curl):

1. `GET {hub}/subscriptions/{subscription}` → `{id, filter, cursor}`. Use
   this cursor, not the one in the ping.
2. `GET {hub}/events?after={cursor}` (append `&types=a,b` if the
   subscription has a type filter) → `{events: [...]}`. Each event is
   `{seq, id, type, source, time, data}`.
3. Handle each event in order, following the standing instructions in your
   prompt. If there are none, summarize the events.
4. Ack only what you handled:
   `POST {hub}/subscriptions/{subscription}/ack` with body
   `{"cursor": "<seq of the last event you handled>"}`.

Never ack events you did not handle — unacked events simply arrive again on
the next wake. To emit an event yourself:
`POST {hub}/events` with `{"type": "...", "source": "...", "data": {...}}`
(or `bb wake emit <type> '<json>'` when the bb CLI is available).
