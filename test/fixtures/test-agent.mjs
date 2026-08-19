#!/usr/bin/env node
// Test wake target: reads pending events, appends their ids to OUT_FILE
// (one per line), acks. Used by the e2e test to observe exactly which
// events got processed and how many times.

import fs from 'node:fs';

const ping = JSON.parse(process.env.WAKE_PING);
const sub = await (await fetch(`${ping.hub}/subscriptions/${ping.subscription}`)).json();
const { events } = await (await fetch(`${ping.hub}/events?after=${sub.cursor}`)).json();

for (const ev of events) fs.appendFileSync(process.env.OUT_FILE, ev.id + '\n');

if (events.length) {
  await fetch(`${ping.hub}/subscriptions/${ping.subscription}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cursor: String(events[events.length - 1].seq) }),
  });
}
