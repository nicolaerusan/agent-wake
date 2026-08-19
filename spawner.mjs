#!/usr/bin/env node
// agent-wake reference spawner — the tiny always-on shim.
//
// Long-polls the hub's mailbox over an outbound connection (NAT-proof, no
// public URL). On each thin ping it spawns WAKE_CMD — the agent — with the
// ping JSON on stdin and in $WAKE_PING. The spawner is NOT the agent: it
// holds no state, makes no decisions, and runs agents strictly one at a
// time (which is what makes coalescing free — events that land during a
// wake are picked up by the next ping).
//
//   HUB_URL=http://localhost:7777 SUB_ID=sub_x WAKE_CMD='node examples/echo-agent.mjs' node spawner.mjs

import { spawnSync } from 'node:child_process';

const HUB = process.env.HUB_URL;
const SUB = process.env.SUB_ID;
const CMD = process.env.WAKE_CMD;
const TIMEOUT_S = Number(process.env.WAIT_TIMEOUT_S || 25);

if (!HUB || !SUB || !CMD) {
  console.error('usage: HUB_URL=... SUB_ID=... WAKE_CMD=... node spawner.mjs');
  process.exit(1);
}

console.log(`spawner: watching ${HUB} sub=${SUB} -> ${CMD}`);

let backoffMs = 1000;
let failBackoffMs = 5000;
for (;;) {
  let ping = null;
  try {
    const res = await fetch(`${HUB}/subscriptions/${SUB}/wait?timeout=${TIMEOUT_S}`);
    if (res.status === 200) ping = await res.json();
    else if (res.status !== 204) throw new Error(`hub said ${res.status}`);
    backoffMs = 1000;
  } catch (err) {
    console.error(`spawner: hub unreachable (${err.message}), retrying in ${backoffMs}ms`);
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 60_000);
    continue;
  }

  if (!ping) continue; // quiet timeout — poll again

  console.log(`spawner: wake (${ping.pending} pending, cursor=${ping.cursor})`);
  const pingJson = JSON.stringify(ping);
  const result = spawnSync(process.env.SHELL || '/bin/sh', ['-c', CMD], {
    input: pingJson,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, WAKE_PING: pingJson },
  });
  if (result.status !== 0) {
    // The events stay pending on the hub, so the next poll would re-wake
    // immediately — back off so a broken agent cannot spin a wake storm.
    console.error(`spawner: agent exited ${result.status}; hub keeps the events, retrying in ${failBackoffMs}ms`);
    await new Promise((r) => setTimeout(r, failBackoffMs));
    failBackoffMs = Math.min(failBackoffMs * 2, 300_000);
  } else {
    failBackoffMs = 5000;
  }
}
