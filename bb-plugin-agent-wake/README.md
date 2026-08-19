# bb-plugin-agent-wake

Wake BB threads from [agent-wake](https://github.com/nicolaerusan/agent-wake) hub events.

A background service long-polls a hub subscription's mailbox (outbound
connection only — NAT-proof). On each thin ping it spawns a thread in your
configured project whose prompt tells the agent to read its pending events
from the hub, handle them per your standing instructions, and ack its
cursor. The plugin holds no event state; the hub's cursor is the truth, so
duplicate or missed wakes are harmless.

## Install

```sh
bb plugin install https://github.com/nicolaerusan/agent-wake --plugin agent-wake
```

Or from a local checkout: `bb plugin install ./bb-plugin-agent-wake`.

## Configure

Settings → Plugins → Agent Wake (or `bb plugin config agent-wake`):

- **Hub URL** — the agent-wake hub (default `http://localhost:7777`).
- **Event types** — comma-separated filter; empty wakes on everything.
- **Project** — where woken threads are spawned (required).
- **Minimum seconds between wakes** — coalescing window; events landing
  during it are picked up by the next ping (default 30).
- **Standing instructions** — appended to every woken thread's prompt; this
  is where you say what the agent should *do* with events.

Then `bb plugin reload agent-wake`.

## CLI

```sh
bb wake emit task.created '{"title":"hello"}'   # emit an event to the hub
bb wake status                                  # hub, subscription, cursor
```

The bundled `agent-wake-protocol` skill teaches woken agents the
read-after-cursor + ack protocol.
