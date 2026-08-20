// The MCP server, spoken to exactly as a client would: JSON-RPC 2.0 over
// stdio, one message per line.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-mcp-'));
let hub;
let HUB_URL;

function startHub() {
  return new Promise((resolve, reject) => {
    hub = spawn('node', [path.join(ROOT, 'hub.mjs')], {
      env: { ...process.env, PORT: '0', WAKE_DATA_DIR: path.join(tmp, 'data') },
    });
    hub.stdout.on('data', (d) => {
      const m = String(d).match(/listening on (http:\/\/localhost:\d+)/);
      if (m) resolve(m[1]);
    });
    hub.on('error', reject);
    setTimeout(() => reject(new Error('hub did not start')), 5000).unref();
  });
}

/** A minimal MCP client: spawn the server, exchange line-delimited JSON-RPC. */
function mcpClient(extraArgs = []) {
  const proc = spawn('node', [path.join(ROOT, 'mcp.mjs'), '--hub', HUB_URL, ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 8000).unref();
    });

  const tool = async (name, args) => {
    const res = await call('tools/call', { name, arguments: args });
    return { ...res.result, json: () => JSON.parse(res.result.content[0].text) };
  };

  return { proc, call, tool, kill: () => proc.kill() };
}

const emit = (type, data, source = 'test') =>
  fetch(`${HUB_URL}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, source, data }),
  }).then((r) => r.json());

before(async () => {
  HUB_URL = await startHub();
});

after(() => hub?.kill());

test('handshake, tool discovery, and scanning events', async () => {
  await emit('task.created', { title: 'first' });
  await emit('deploy.finished', { ok: true });

  const client = mcpClient();
  try {
    const init = await client.call('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'agent-wake');
    assert.ok(init.result.capabilities.tools, 'declares tool capability');

    const { result } = await client.call('tools/list');
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('wake_scan_events'));
    assert.ok(names.includes('wake_pending'));
    assert.ok(names.includes('wake_emit_event'), 'emit is on by default');
    assert.ok(!names.includes('wake_ack'), 'ack is off by default');

    const scan = await client.tool('wake_scan_events', {});
    const body = scan.json();
    assert.equal(body.events.length, 2);
    assert.equal(body.events[0].type, 'task.created');

    const filtered = (await client.tool('wake_scan_events', { types: 'deploy.finished' })).json();
    assert.equal(filtered.events.length, 1, 'type filter applies');
    assert.equal(filtered.events[0].data.ok, true);
  } finally {
    client.kill();
  }
});

test('pending view reports exactly what a wake rule has not seen', async () => {
  const sub = await fetch(`${HUB_URL}/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filter: { types: ['task.created'] } }),
  }).then((r) => r.json());

  await emit('task.created', { title: 'after subscribing' });
  await emit('unrelated.event', { noise: true });

  const client = mcpClient();
  try {
    const pending = (await client.tool('wake_pending', { subscription: sub.id })).json();
    assert.equal(pending.pending, 1, 'only the matching event is pending');
    assert.equal(pending.events[0].data.title, 'after subscribing');

    const list = (await client.tool('wake_list_subscriptions', {})).json();
    const mine = list.subscriptions.find((s) => s.id === sub.id);
    assert.equal(mine.pending, 1);
  } finally {
    client.kill();
  }
});

test('--read-only withholds writes; --allow-ack is opt-in', async () => {
  const ro = mcpClient(['--read-only']);
  try {
    const { result } = await ro.call('tools/list');
    const names = result.tools.map((t) => t.name);
    assert.deepEqual(
      names.filter((n) => n.includes('emit') || n.includes('ack')),
      [],
      'no write tools offered',
    );

    const attempt = await ro.tool('wake_emit_event', { type: 'should.not.happen' });
    assert.equal(attempt.isError, true, 'calling a withheld tool errors');
    assert.match(attempt.content[0].text, /read-only/);
  } finally {
    ro.kill();
  }

  const rw = mcpClient(['--allow-ack']);
  try {
    const { result } = await rw.call('tools/list');
    assert.ok(result.tools.map((t) => t.name).includes('wake_ack'));
  } finally {
    rw.kill();
  }
});

test('emitting through MCP lands a real event in the inbox', async () => {
  const client = mcpClient();
  try {
    const out = (await client.tool('wake_emit_event', {
      type: 'mcp.wrote',
      data: { via: 'tool' },
    })).json();
    assert.match(out.id, /^evt_/);

    const { events } = await fetch(`${HUB_URL}/events?after=0&types=mcp.wrote`).then((r) => r.json());
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'mcp', 'source is stamped');
    assert.deepEqual(events[0].data, { via: 'tool' });
  } finally {
    client.kill();
  }
});
