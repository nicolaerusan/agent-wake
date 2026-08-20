# Tweet thread — push vs pull agents / a wake standard (draft)

1/
Every agent today is either always-on (expensive, mostly idle) or asleep (useless until a human pokes it).

The missing layer of the agent stack isn't intelligence. It's a boring, vendor-neutral standard for *waking* agents.

2/
The web has solved this problem at least four times:

• RSS: pull. WebSub: push upgrade for feeds
• email: federated mailboxes, MX records = "how to reach me"
• ActivityPub: every actor has an inbox URL
• webhooks/CloudEvents: events between services

Agents have… nothing. Everyone polls or stays hot.

3/
The obvious move — "agents expose a webhook" — is right, but only with one inversion from normal webhooks:

the webhook is a nudge, not a delivery channel.

4/
Normal webhooks push payloads, so reliability machinery grows around delivery: retries, ordering, dedup, signature paranoia.

Instead: events live in a durable append-only log. The ping just says "something's waiting, here's your cursor." The agent goes and reads.

5/
The whole standard is three primitives (friendly names first):

• event inbox (hub): typed events, stable IDs, per-stream order
• wake rule + bookmark (subscription + cursor)
• doorbell (thin ping): {hub, subscription, cursor, pending}

Dropped ping? Duplicate? Agent offline a week? Cursor catches up. Push is just a latency optimization over pull.

6/
Agents are the one webhook receiver where invocation costs real money — every wake boots a reasoning loop.

So the subscription carries economics: hub-side filters, min intervals, batch windows. 10 events in a minute = 1 wake. No existing webhook standard has this, and agents need it.

7/
Push vs pull isn't a religious choice, it's a delivery mode:

• push: signed thin ping to a public URL (or tunnel)
• pull: a tiny local shim long-polls a mailbox — outbound only, NAT-proof

Same subscription, same cursor. Most agents live on laptops; pull is the mode that makes them first-class.

8/
And the wake target shouldn't be a running process — it's a *wake watcher*.

Doorbell → a small background service starts `claude -p`, `codex exec`, a BB thread, or a hosted job → the working agent reads its inbox, works, records progress, exits.

The code calls this watcher a spawner, but it isn't another intelligent agent. It's boring plumbing. Durable progress lives in the event inbox. Compute is wherever the working agent runs today.

9/
This also unifies "automations." A cron trigger, a GitHub event, an email, another agent's output — all just event sources feeding hubs. IFTTT/Zapier proved the trigger→action economy works; it just isn't open. An open hub + subscription standard is that, but federated.

10/
The email analogy is the endgame: an agent should have the equivalent of an MX record — a published, standard way to say "here is how to wake me."

Any hub, any host, any vendor. That's when agents stop being apps and start being addressable participants.

11/
Nothing here needs inventing: CloudEvents envelope, Standard Webhooks signing, WebSub subscription dance, ActivityPub's inbox instinct.

The new ~2 pages of spec: cursors as correctness, hub-side filters as the cost gate, wake economics as first-class.

Who wants to help write it down?
