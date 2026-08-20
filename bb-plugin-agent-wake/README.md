# bb-plugin-agent-wake

Wake BB threads from an [agent-wake](https://github.com/nicolaerusan/agent-wake) event inbox.

The plugin is the **wake watcher**: a small background service that long-polls
one wake rule in the event inbox (outbound connection only — NAT-proof). When
the doorbell rings, it starts a BB thread in your configured project. That
thread is the **working agent**: it reads pending events, handles them under the
project's permissions and your standing instructions, and records its progress.
The plugin holds no event state; the inbox's cursor is the truth, so duplicate
or missed wakes are harmless.

See [the concrete architecture guide](../ARCHITECTURE.md) for the same roles in
Claude Code, Codex, desktop, and hosted-agent deployments. The current hub is
unauthenticated localhost plumbing; review [SECURITY.md](../SECURITY.md) before
using real or sensitive events.

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
