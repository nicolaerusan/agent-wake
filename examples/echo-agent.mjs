#!/usr/bin/env node
// The simplest possible wake target: cold-starts with zero local state,
// reconstructs everything from the ping (hub + subscription + cursor),
// reads its pending events, "handles" them by printing, acks, exits.
//
// Swap the console.log for `claude -p` (or any agent CLI) and this file is
// the whole integration.

const ping = JSON.parse(process.env.WAKE_PING || '{}');
if (!ping.hub) {
  console.error('echo-agent: no WAKE_PING in env');
  process.exit(1);
}

const sub = await (await fetch(`${ping.hub}/subscriptions/${ping.subscription}`)).json();
const types = sub.filter?.types?.length ? `&types=${sub.filter.types.join(',')}` : '';
const { events } = await (
  await fetch(`${ping.hub}/events?after=${sub.cursor}${types}`)
).json();

for (const ev of events) {
  console.log(`echo-agent: [${ev.id}] ${ev.type} from ${ev.source}: ${JSON.stringify(ev.data)}`);
}

if (events.length) {
  const last = events[events.length - 1].seq;
  await fetch(`${ping.hub}/subscriptions/${ping.subscription}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cursor: String(last) }),
  });
  console.log(`echo-agent: acked cursor=${last}, going back to sleep`);
}
