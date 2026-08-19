# Push vs pull agents, and the case for a wake standard

*Draft blog post — Aug 2026*

*A note on authorship: this essay was written by an AI agent (Claude), drafted from my conversations with it about this idea. I've reviewed and published it because the thinking is worth sharing — but the words are mostly the agent's, which feels fitting for a post about waking agents.*

There's a gap in the agent stack that nobody has named properly yet. We have standards for what agents can *do* (tool use, MCP), and emerging conventions for how they *talk*. But we don't have an answer for the question that comes before either: **when should an agent be running at all?**

Today you get two bad options. An agent is either always-on — a process burning inference dollars while it waits for something to happen — or it's asleep, inert until a human remembers to invoke it. The first doesn't scale economically; the second doesn't scale organizationally. If agents are going to participate in shared work — claiming tasks, reacting to reviews, responding to each other, running automations — they need to be *wakeable*: dormant by default, summoned by events.

This isn't a product feature. It's plumbing, and plumbing wants a standard. Call it agent webhooks, agent subscriptions, wake triggers — the name matters less than the observation that every agent platform is currently reinventing it privately, and the web has already shown us, several times over, what the public version should look like.

## The web has solved this before

Every era of the web has produced a push-vs-pull protocol, and the pattern of what worked is remarkably consistent:

- **RSS was pull.** Everyone polled feeds, it was wasteful and slow, and **WebSub (né PubSubHubbub)** layered a push upgrade on top: a hub, a subscription, a ping. Crucially, the feed remained the source of truth — push was an optimization, and polling always still worked.
- **Email is the great federated mailbox.** An MX record is a published, standard answer to "how do you reach me?" Any sender, any receiver, any host. Nobody asks whether your mail server and mine are from the same vendor.
- **ActivityPub** gave every actor in the fediverse an inbox URL and an outbox. Federated social messaging works because *addressability* is part of the actor's identity, not a platform feature.
- **Webhooks, CloudEvents, EventBridge** made services event-driven — and the Standard Webhooks effort exists precisely because everyone had built the same thing incompatibly for fifteen years.
- **IFTTT and Zapier** proved there's an entire economy in trigger → action. But it's a closed one: the triggers live in proprietary hubs.

Agents are the newest kind of network participant, and right now they have none of this. No MX record. No inbox. No standard trigger. Every framework has a private notion of scheduling and every platform a private notion of events, so agents can only be woken by the platform they live inside.

## What the standard actually needs to say

Surprisingly little. Three primitives:

**An event hub** — a durable, append-only log of typed events with stable IDs and per-stream ordering. Anyone can run one: a task platform, a repo host, a calendar, a personal server. CloudEvents already gives us the envelope.

**A subscription** — a resource an agent creates against a hub: a filter (event types, streams, predicates), a delivery target, and — the load-bearing part — a **cursor** marking the last event the agent has processed.

**A thin ping** — the wake itself:

```json
POST /wake
{
  "hub": "https://hub.example.com",
  "subscription": "sub_9f3k",
  "cursor": "evt_01J8...",
  "pending": 3
}
```

No payload. The ping is a nudge, not a delivery channel. On wake, the agent authenticates to the hub, reads events after its cursor, does its work, and acks by advancing the cursor.

This one inversion — payload stays in the log, ping carries a reference — dissolves most of what makes webhook systems hard. Dropped pings are harmless; the next ping or a routine poll catches the agent up. Duplicates and reordering are harmless; reading from a cursor is idempotent. Spoofing is nearly harmless; the agent never acts on ping contents, only on what it reads from the authenticated log, so payload signing becomes defense in depth rather than the security boundary. Delivery stops being where correctness lives. **Push is purely a latency optimization over pull**, exactly the lesson WebSub taught: the feed is the truth, the ping is a courtesy.

## Push vs pull is a delivery mode, not an architecture

The dichotomy dissolves once cursors carry correctness. The same subscription supports two modes:

**Push**, for agents with a public URL: the signed thin ping, Standard-Webhooks-style headers, WebSub-style verification at registration. A tunnel counts — and because pings are thin, a relay in the middle never carries anything worth stealing.

**Pull**, for everyone else — which today means *most agents*, living on laptops and workstations behind NAT with no public IP and, crucially, no running process most of the time. A tiny always-on shim long-polls the hub's mailbox over an outbound connection and receives the identical ping the webhook would have carried. The shim isn't the agent; it's a spawner. (Pull agents can't answer a URL challenge at registration, so they prove liveness the other way: by acking. A subscription that never acks parks itself; events keep accumulating; nothing is lost.)

A spec that makes pull the mandatory-to-implement mode and push the optimization gets the priorities right. It's what makes "any laptop is a valid agent host" true.

## Agents are the one receiver where invocation costs money

Webhook standards assume receivers are cheap to invoke. An agent is the one kind of receiver where that's false: every wake boots a reasoning loop, and reasoning loops cost real money. A wake standard that ignores this will bankrupt its participants with well-intentioned notifications.

So the subscription must carry economics, enforced hub-side:

- **Filters run at the hub** — the cheap predicate gate fires before the expensive agent boots.
- **Batching and minimum intervals** — ten events in a minute produce one wake, not ten. Thin pings make coalescing natural: "3 pending" and "300 pending" are the same ping.
- **Parking over infinite retries** — a target that keeps failing pauses; the log keeps the events; the cursor resumes cleanly.

This is the genuinely novel section of the spec — the part no existing webhook standard has, because no previous receiver needed it.

## The spawner insight

The deepest consequence of thin pings: the wake target isn't a running process, it's *whatever knows how to start one*. A cron trigger, a CI runner, a serverless function, a local daemon that shells out to an agent CLI — all valid wake targets. A freshly spawned agent has zero local state and needs none, because the ping is self-describing: hub URL, subscription, cursor. Read, work, ack, exit.

Which means the agent's durable identity — who it is, what it watches, how far it has read — lives at the hub, not in any process. Wake the same agent on a different machine tomorrow and nothing breaks. This is also what unifies "automations" with agents: a Zapier-style trigger→action rule and a long-lived agent teammate are the same protocol shape, differing only in how much thinking happens after the wake.

## The endgame is an MX record for agents

Follow the email analogy to its conclusion. What made email a substrate rather than a product was that *addressability was standardized and hosting was not*. Anyone could run a mail server; everyone could reach everyone.

The agent equivalent: a published, standard way for any agent to say "here is how to wake me" — push URL or mailbox, hub-agnostic, host-agnostic, vendor-agnostic. Any event hub can wake any agent its owner subscribed it to. At that point agents stop being features of platforms and become addressable participants in a network, the way mailboxes and websites and fediverse actors are.

Almost none of this needs inventing. CloudEvents for the envelope. Standard Webhooks for signing and retries. WebSub for the subscription dance. ActivityPub for the instinct that an inbox is part of identity. The new material is maybe two pages: **cursors as the correctness mechanism, hub-side filters as the cost gate, wake economics as a first-class concern.** It should be boring. Plumbing wins by being uninteresting.

If you're building agent infrastructure and reinventing this privately, let's write the public version instead.

## Notes toward an MVP

What's the smallest thing that proves the shape? Roughly a weekend of plumbing:

1. **A reference hub** — one process, SQLite, an append-only `events` table (CloudEvents-ish envelope: `id`, `type`, `source`, `time`, `data`), and three routes: `POST /events` (ingest), `GET /events?after=<cursor>&filter=...` (the read path that makes everything else optional), and CRUD for `subscriptions`.
2. **The mailbox** — `GET /subscriptions/:id/wait?timeout=55s`, long-poll, returns the thin ping or 204. Plus `POST /subscriptions/:id/ack {cursor}`. This is the mandatory mode; ship it first.
3. **The push worker** — signs and delivers thin pings to webhook subscriptions with Standard-Webhooks headers, coalesces within the batch window, honors `min_interval_s`, parks after N failures.
4. **A reference spawner** — a ~50-line daemon that long-polls the mailbox and, on ping, shells out to an agent CLI (`claude -p`, or anything) with the ping as the prompt. This is the demo that lands: laptop closed to the world, agent wakes anyway.
5. **One real event source** — a bridge that forwards GitHub webhooks (or an RSS poll, or an email inbox) into the hub, so the demo is "issue opened → agent on your laptop wakes, comments, goes back to sleep."
6. **A conformance suite** — a dozen black-box tests that define what "is a hub" and "is a wake target" mean: cursor idempotency, duplicate-ping harmlessness, coalescing, parking, resume-after-a-week. The tests *are* the standard until the prose catches up.

Non-goals for the MVP: federation between hubs, discovery, payment, any agent framework integration beyond "spawn a CLI." Those all get easier to design once two implementations exist and disagree about something.
