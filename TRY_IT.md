# Try agent-wake in five minutes

The first demo uses a tiny bundled “echo agent.” It visibly wakes, reads an
event, records progress, and exits. It needs no API key, AI account, or global
npm installation.

Requirements: Git and Node.js 20 or newer.

## 1. Get the repository

```sh
git clone https://github.com/nicolaerusan/agent-wake.git
cd agent-wake
```

There are no runtime dependencies to install.

## 2. Start the event inbox

Open terminal 1 in the repository:

```sh
node bin/agent-wake.mjs hub --data-dir /tmp/agent-wake-demo
```

Expected output:

```text
agent-wake hub listening on http://localhost:7777
```

Keep it running. The current reference inbox is intentionally unauthenticated,
so use it only on localhost with test data.

## 3. Start the wake watcher

Open terminal 2 in the same repository:

```sh
node bin/agent-wake.mjs watch --echo
```

This creates a wake rule and waits cheaply. `--echo` uses the bundled visible
target instead of a real model, so it is ideal for seeing the protocol first.

## 4. Make something happen

Open terminal 3 in the same repository:

```sh
node bin/agent-wake.mjs emit task.created \
  --data '{"title":"Explain why the build failed"}'
```

Terminal 2 should show something like:

```text
spawner: wake (1 pending, cursor=0)
echo-agent: [evt_00000001] task.created from cli: {"title":"Explain why the build failed"}
echo-agent: acked cursor=1, going back to sleep
```

Emit another event. The same watcher starts another fresh target, which resumes
from the saved bookmark rather than processing event 1 again.

## Try a filter

Stop terminal 2 with Ctrl-C and start a watcher that only cares about failed
deployments:

```sh
node bin/agent-wake.mjs watch --echo --types deploy.failed
```

This event is stored but does not ring that watcher's doorbell:

```sh
node bin/agent-wake.mjs emit task.created --data '{"title":"quiet"}'
```

This one does:

```sh
node bin/agent-wake.mjs emit deploy.failed \
  --data '{"service":"checkout","environment":"staging"}'
```

The current implementation applies the type filter in the bundled echo target,
but the hub does not yet enforce subscription-scoped reads. Treat filtering as
a demo behavior, not a confidentiality boundary; see [SECURITY.md](SECURITY.md).

## Replace the echo target with a real agent

Once the flow makes sense, stop the echo watcher and choose one target.

### Claude Code CLI

Install and authenticate Claude Code, then run:

```sh
node bin/agent-wake.mjs watch --claude -- \
  --allowedTools 'Bash(curl:*)'
```

This repository currently launches `claude -p`. It does not create a Claude
desktop-app conversation.

### Codex CLI

Install and authenticate Codex, then run:

```sh
node bin/agent-wake.mjs watch --codex -- \
  --sandbox workspace-write \
  -c 'sandbox_workspace_write.network_access=true'
```

The network setting lets the local Codex process reach the localhost event
inbox. Keep its filesystem and other permissions narrow. This repository
currently launches `codex exec`; it does not create a ChatGPT desktop or Codex
cloud task.

### Any command

```sh
node bin/agent-wake.mjs watch --cmd 'node my-agent.mjs'
```

The command receives the doorbell JSON on stdin and in `$WAKE_PING`.

## Run the conformance tests

```sh
npm test
```

The tests start temporary hubs and real child processes, check restart recovery,
filters, durable cursors, duplicate doorbells, and the CLI flow.

## What this demo does not prove

The reference hub is still localhost-only plumbing. It does not yet provide
publisher credentials, subscription capabilities, private spaces, strict cursor
validation, hub-enforced filtered reads, parking, or wake budgets. Do not expose
port 7777 or use sensitive event data. The implementation roadmap is in
[SECURITY.md](SECURITY.md), and the larger shared-service design is in
[GLOBAL_EVENT_BUS.md](GLOBAL_EVENT_BUS.md).
