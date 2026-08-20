#!/usr/bin/env node
// agent-wake webhook ingest — turn ordinary HTTP webhooks into inbox events.
//
// The hub itself is unauthenticated localhost plumbing (see SECURITY.md), so
// it should never be the thing a stranger POSTs to. This bridge is the piece
// that faces the outside world: it authenticates the sender, decides the
// event type and source itself, and only then writes into the hub.
//
//   agent-wake ingest --token SECRET [--hub URL] [--port 7788]
//                     [--github-secret S] [--types-prefix hook] [--bind HOST]
//
//   POST /hook/<name>            -> event type "<prefix>.<name>", source "hook:<name>"
//   POST /github                 -> event type "github.<X-GitHub-Event>"  (HMAC verified)
//
// Every request must present the shared token (X-Wake-Token header or
// ?token=), except /github, which proves itself with its HMAC signature
// instead. The bridge stamps `source` from the route it authenticated —
// callers cannot claim to be someone else. It binds to 127.0.0.1 unless you
// pass --bind explicitly, because exposing it means accepting that whoever
// can reach it can wake your agents.

import http from 'node:http';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const HUB = value('hub', process.env.HUB_URL || 'http://localhost:7777');
const PORT = Number(value('port', process.env.INGEST_PORT || 7788));
const BIND = value('bind', '127.0.0.1');
const TOKEN = value('token', process.env.INGEST_TOKEN || '');
const GITHUB_SECRET = value('github-secret', process.env.INGEST_GITHUB_SECRET || '');
const PREFIX = value('types-prefix', 'hook');
const MAX_BYTES = Number(value('max-bytes', 256 * 1024));

if (!TOKEN && !GITHUB_SECRET) {
  console.error(
    'ingest: refusing to start with no credentials.\n' +
      '  pass --token <secret> for generic webhooks, and/or\n' +
      '  --github-secret <secret> for GitHub deliveries.',
  );
  process.exit(1);
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

// Constant-time compare that never throws on length mismatch.
const secureEquals = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

// Event types are ours to define, not the caller's: keep them boring.
const safeName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64) || 'unnamed';

const emit = async (type, source, data) => {
  const res = await fetch(`${HUB}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, source, data }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`hub ${res.status}: ${body.error || ''}`);
  return body;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, hub: HUB });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return json(res, 413, { error: err.message });
  }

  const parse = () => {
    const text = raw.toString('utf8');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON (form posts, plain text) — keep it, clearly marked as raw.
      return { raw: text.slice(0, 8000) };
    }
  };

  try {
    // GitHub proves itself with an HMAC over the exact bytes it sent.
    if (parts[0] === 'github') {
      if (!GITHUB_SECRET) return json(res, 404, { error: 'github ingest not enabled' });
      const sig = req.headers['x-hub-signature-256'];
      const expected =
        'sha256=' + crypto.createHmac('sha256', GITHUB_SECRET).update(raw).digest('hex');
      if (!sig || !secureEquals(sig, expected)) {
        return json(res, 401, { error: 'bad signature' });
      }
      const event = safeName(req.headers['x-github-event'] || 'unknown');
      const out = await emit(`github.${event}`, 'github', parse());
      return json(res, 201, out);
    }

    // Everything else: shared token, and we name the source after the route.
    if (parts[0] === 'hook') {
      if (!TOKEN) return json(res, 404, { error: 'token ingest not enabled' });
      const presented = req.headers['x-wake-token'] || url.searchParams.get('token') || '';
      if (!secureEquals(presented, TOKEN)) return json(res, 401, { error: 'bad token' });
      const name = safeName(parts[1] || 'default');
      const out = await emit(`${PREFIX}.${name}`, `hook:${name}`, parse());
      return json(res, 201, out);
    }

    return json(res, 404, { error: 'POST /hook/<name> or POST /github' });
  } catch (err) {
    return json(res, 502, { error: String(err.message || err) });
  }
});

server.listen(PORT, BIND, () => {
  const actual = server.address().port;
  console.log(`agent-wake ingest listening on http://${BIND}:${actual} -> ${HUB}`);
  if (TOKEN) console.log(`  POST /hook/<name>  (X-Wake-Token, or ?token=)`);
  if (GITHUB_SECRET) console.log(`  POST /github       (X-Hub-Signature-256 verified)`);
  if (BIND !== '127.0.0.1') {
    console.log(
      `  ! bound to ${BIND}: anyone who reaches this port and holds the token can wake your agents`,
    );
  }
});
