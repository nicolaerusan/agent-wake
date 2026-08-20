// End-to-end: hub + spawner + a real spawned agent process, black-box over HTTP.
// This is the seed of the conformance suite — the properties tested here
// (ordered successful processing via cursors, restart resume, filter gating,
// durability) are the standard until the prose catches up.
//
//   node --test test/

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-'));
const OUT_FILE = path.join(tmp, 'processed.txt');
fs.writeFileSync(OUT_FILE, '');

let hub; // child process
let HUB_URL;
let spawner;

function startHub() {
  return new Promise((resolve, reject) => {
    hub = spawn('node', [path.join(ROOT, 'hub.mjs')], {
      env: { ...process.env, PORT: '0', WAKE_DATA_DIR: path.join(tmp, 'data') },
    });
    hub.stderr.on('data', (d) => process.stderr.write(`[hub] ${d}`));
    hub.stdout.on('data', (d) => {
      const m = String(d).match(/listening on (http:\/\/localhost:\d+)/);
      if (m) resolve(m[1]);
    });
    hub.on('error', reject);
    setTimeout(() => reject(new Error('hub did not start')), 5000).unref();
  });
}

function startSpawner(subId) {
  spawner = spawn('node', [path.join(ROOT, 'spawner.mjs')], {
    env: {
      ...process.env,
      HUB_URL,
      SUB_ID: subId,
      WAKE_CMD: `node ${path.join(ROOT, 'test/fixtures/test-agent.mjs')}`,
      OUT_FILE,
      WAIT_TIMEOUT_S: '2',
    },
    stdio: 'ignore',
  });
}

const api = async (method, p, body) => {
  const res = await fetch(`${HUB_URL}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const emit = (type, data) => api('POST', '/events', { type, source: 'e2e', data });

const processedIds = () =>
  fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(Boolean);

async function waitUntil(fn, ms = 10_000, why = 'condition') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${why}`);
}

let sub;

before(async () => {
  HUB_URL = await startHub();
  ({ body: sub } = await api('POST', '/subscriptions', {}));
});

after(() => {
  spawner?.kill();
  hub?.kill();
});

test('spawner wakes a cold agent which processes a successful batch once, in order', async () => {
  startSpawner(sub.id);
  await emit('task.created', { n: 1 });
  await emit('task.created', { n: 2 });
  await emit('review.requested', { n: 3 });

  await waitUntil(() => processedIds().length >= 3, 10_000, 'first 3 events');
  await emit('task.created', { n: 4 });
  await emit('task.created', { n: 5 });
  await waitUntil(() => processedIds().length >= 5, 10_000, 'all 5 events');

  const ids = processedIds();
  assert.equal(ids.length, 5, 'no event processed twice');
  assert.deepEqual(ids, [...new Set(ids)], 'ids are unique');
  assert.deepEqual(ids, [...ids].sort(), 'ids arrive in order');
});

test('cursor survives spawner restart: no reprocessing, no loss', async () => {
  spawner.kill();
  await new Promise((r) => setTimeout(r, 200));

  await emit('task.created', { n: 6 });
  await emit('task.created', { n: 7 });
  assert.equal(processedIds().length, 5, 'nothing processed while spawner is down');

  startSpawner(sub.id);
  await waitUntil(() => processedIds().length >= 7, 10_000, 'resume after restart');
  const ids = processedIds();
  assert.equal(ids.length, 7, 'exactly the 2 missed events, no replays');
  assert.deepEqual(ids, [...new Set(ids)]);
});

test('a duplicate/stale wake is harmless (cursor is the truth, not the ping)', async () => {
  await waitUntil(async () => (await api('GET', `/subscriptions/${sub.id}`)).body.cursor === 7, 5000, 'ack of event 7');
  const before = processedIds().length;
  const stalePing = { hub: HUB_URL, subscription: sub.id, cursor: '1', pending: 6 };
  const r = spawnSync('node', [path.join(ROOT, 'test/fixtures/test-agent.mjs')], {
    env: { ...process.env, WAKE_PING: JSON.stringify(stalePing), OUT_FILE },
  });
  assert.equal(r.status, 0);
  assert.equal(processedIds().length, before, 'stale ping caused no reprocessing');
});

test('filtered subscriptions only wake for matching event types', async () => {
  const { body: filtered } = await api('POST', '/subscriptions', {
    filter: { types: ['deploy.finished'] },
  });

  await emit('task.created', { noise: true });
  const quiet = await api('GET', `/subscriptions/${filtered.id}/wait?timeout=1`);
  assert.equal(quiet.status, 204, 'non-matching event does not wake');

  await emit('deploy.finished', { ok: true });
  const woken = await api('GET', `/subscriptions/${filtered.id}/wait?timeout=5`);
  assert.equal(woken.status, 200);
  assert.equal(woken.body.pending, 1, 'thin ping reports one pending event');
});

test('hub restart preserves events and cursors (append-only log is the truth)', async () => {
  const { body: beforeRestart } = await api('GET', `/subscriptions/${sub.id}`);
  hub.kill();
  await new Promise((r) => setTimeout(r, 200));

  HUB_URL = await startHub();
  const { body: eventsAfter } = await api('GET', '/events?after=0');
  assert.ok(eventsAfter.events.length >= 9, 'all events survive restart');
  const { body: subAfter } = await api('GET', `/subscriptions/${sub.id}`);
  assert.equal(subAfter.cursor, beforeRestart.cursor, 'cursor survives restart');
});
