// End-to-end over the CLI: `agent-wake hub`, `agent-wake sub/emit/events`,
// and `agent-wake watch --cmd` waking a real agent process.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const CLI = path.join(ROOT, 'bin/agent-wake.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-cli-'));
const OUT_FILE = path.join(tmp, 'processed.txt');
fs.writeFileSync(OUT_FILE, '');

let hub;
let HUB_URL;
let watcher;

const cli = (...args) =>
  execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HUB_URL } });

before(async () => {
  HUB_URL = await new Promise((resolve, reject) => {
    hub = spawn('node', [CLI, 'hub', '--port', '0', '--data-dir', path.join(tmp, 'data')]);
    hub.stderr.on('data', (d) => process.stderr.write(`[hub] ${d}`));
    hub.stdout.on('data', (d) => {
      const m = String(d).match(/listening on (http:\/\/localhost:\d+)/);
      if (m) resolve(m[1]);
    });
    hub.on('error', reject);
    setTimeout(() => reject(new Error('hub did not start')), 5000).unref();
  });
});

after(() => {
  watcher?.kill();
  hub?.kill();
});

test('sub / emit / events round-trip through the CLI', () => {
  const sub = JSON.parse(cli('sub', '--types', 'task.created'));
  assert.ok(sub.id.startsWith('sub_'));
  assert.deepEqual(sub.filter.types, ['task.created']);

  const emitted = JSON.parse(cli('emit', 'task.created', '--data', '{"n":1}'));
  assert.ok(emitted.id.startsWith('evt_'));

  const { events } = JSON.parse(cli('events', '--after', String(emitted.seq - 1)));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'task.created');
  assert.deepEqual(events[0].data, { n: 1 });
});

test('watch --cmd auto-creates a subscription and wakes the agent', async () => {
  watcher = spawn(
    'node',
    [
      CLI, 'watch',
      '--hub', HUB_URL,
      '--cmd', `node ${path.join(ROOT, 'test/fixtures/test-agent.mjs')}`,
      '--wait-timeout', '2',
    ],
    { env: { ...process.env, OUT_FILE } },
  );
  watcher.stderr.on('data', (d) => process.stderr.write(`[watch] ${d}`));

  await new Promise((resolve, reject) => {
    watcher.stdout.on('data', (d) => {
      if (String(d).includes('created subscription')) resolve();
    });
    setTimeout(() => reject(new Error('watch did not create a subscription')), 5000).unref();
  });

  cli('emit', 'task.created', '--data', '{"n":2}');

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.readFileSync(OUT_FILE, 'utf8').trim()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ids = fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(Boolean);
  assert.ok(ids.length >= 1, 'agent processed the emitted event');
});
