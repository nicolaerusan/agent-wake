// The webhook bridge: what it accepts, what it refuses, and what it refuses
// to let a caller claim about itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-ingest-'));
const TOKEN = 'test-token-value';
const GH_SECRET = 'test-github-secret';

let hub;
let HUB_URL;
let ingest;
let INGEST_URL;

const startProc = (file, args, env, pattern) =>
  new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(ROOT, file), ...args], { env: { ...process.env, ...env } });
    proc.stderr.on('data', (d) => process.stderr.write(`[${file}] ${d}`));
    proc.stdout.on('data', (d) => {
      const m = String(d).match(pattern);
      if (m) resolve({ proc, url: m[1] });
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error(`${file} did not start`)), 5000).unref();
  });

const post = (path, body, headers = {}) =>
  fetch(`${INGEST_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const hubEvents = (types) =>
  fetch(`${HUB_URL}/events?after=0${types ? `&types=${types}` : ''}`)
    .then((r) => r.json())
    .then((b) => b.events);

before(async () => {
  ({ proc: hub, url: HUB_URL } = await startProc(
    'hub.mjs',
    [],
    { PORT: '0', WAKE_DATA_DIR: path.join(tmp, 'data') },
    /listening on (http:\/\/localhost:\d+)/,
  ));
  const started = await startProc(
    'ingest.mjs',
    ['--hub', HUB_URL, '--port', '0', '--token', TOKEN, '--github-secret', GH_SECRET],
    {},
    /listening on (http:\/\/127\.0\.0\.1:\d+)/,
  );
  ingest = started.proc;
  INGEST_URL = started.url;
});

after(() => {
  ingest?.kill();
  hub?.kill();
});

test('an authenticated webhook becomes an event', async () => {
  const res = await post('/hook/ci', { build: 41, status: 'green' }, { 'x-wake-token': TOKEN });
  assert.equal(res.status, 201);

  const events = await hubEvents('hook.ci');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'hook.ci', 'type derives from the route');
  assert.equal(events[0].source, 'hook:ci', 'source is stamped by the bridge');
  assert.deepEqual(events[0].data, { build: 41, status: 'green' });
});

test('the token also travels as a query parameter, for dumb senders', async () => {
  const res = await post(`/hook/forms?token=${TOKEN}`, { field: 'value' });
  assert.equal(res.status, 201);
  assert.equal((await hubEvents('hook.forms')).length, 1);
});

test('no token, wrong token, and unknown routes are refused', async () => {
  assert.equal((await post('/hook/ci', { sneak: true })).status, 401);
  assert.equal((await post('/hook/ci', { sneak: true }, { 'x-wake-token': 'wrong' })).status, 401);
  assert.equal((await post('/nope', {}, { 'x-wake-token': TOKEN })).status, 404);

  const all = await hubEvents();
  assert.ok(
    all.every((e) => !e.data?.sneak),
    'nothing unauthorized reached the inbox',
  );
});

test('a caller cannot dictate its own source or event type', async () => {
  await post(
    '/hook/untrusted',
    { type: 'github.push', source: 'github', data: { spoofed: true } },
    { 'x-wake-token': TOKEN },
  );
  const events = await hubEvents('hook.untrusted');
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'hook:untrusted', 'claimed source ignored');
  assert.equal(
    (await hubEvents('github.push')).length,
    0,
    'claimed type never became a real github event',
  );
});

test('route names are sanitized into boring event types', async () => {
  await post('/hook/..%2Fweird%20NAME!!', {}, { 'x-wake-token': TOKEN });
  const created = (await hubEvents()).filter((e) => e.source.startsWith('hook:') && e.type !== 'hook.ci');
  assert.ok(
    created.every((e) => /^hook\.[a-z0-9._-]+$/.test(e.type)),
    `event types stay boring: ${created.map((e) => e.type).join(', ')}`,
  );
});

test('GitHub deliveries are accepted only with a valid HMAC signature', async () => {
  const payload = JSON.stringify({ action: 'opened', issue: { number: 7 } });
  const sign = (body, secret) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  const bad = await post('/github', payload, {
    'x-github-event': 'issues',
    'x-hub-signature-256': sign(payload, 'wrong-secret'),
  });
  assert.equal(bad.status, 401, 'a wrong signature is refused');

  const unsigned = await post('/github', payload, { 'x-github-event': 'issues' });
  assert.equal(unsigned.status, 401, 'an unsigned delivery is refused');

  const good = await post('/github', payload, {
    'x-github-event': 'issues',
    'x-hub-signature-256': sign(payload, GH_SECRET),
  });
  assert.equal(good.status, 201);

  const events = await hubEvents('github.issues');
  assert.equal(events.length, 1, 'only the correctly signed delivery landed');
  assert.equal(events[0].source, 'github');
  assert.equal(events[0].data.issue.number, 7);
});

test('non-JSON bodies are kept as raw text rather than dropped', async () => {
  await post('/hook/plain', 'not json at all', {
    'x-wake-token': TOKEN,
    'content-type': 'text/plain',
  });
  const events = await hubEvents('hook.plain');
  assert.equal(events[0].data.raw, 'not json at all');
});

test('refuses to start with no credentials at all', async () => {
  const proc = spawn('node', [path.join(ROOT, 'ingest.mjs'), '--port', '0']);
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /refusing to start with no credentials/);
});
