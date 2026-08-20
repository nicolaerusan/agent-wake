#!/usr/bin/env node
// agent-wake reference hub — zero dependencies, one process.
//
//   POST /events                        {type, source?, data?} -> {id, seq}
//   GET  /events?after=<seq>&types=a,b  -> {events: [...], cursor}
//   GET  /subscriptions                 -> [subscription, ...]
//   POST /subscriptions                 {filter?: {types?}, from?: 'head'|'start'} -> subscription
//   GET  /subscriptions/:id             -> subscription
//   GET  /subscriptions/:id/wait?timeout=25  -> thin ping, or 204 at timeout
//   POST /subscriptions/:id/ack         {cursor} -> subscription
//
// Events are append-only (data/events.jsonl). Subscriptions hold cursors
// (data/subs.json). The ping carries no payload — agents read from their
// cursor and ack. Push delivery is a later optimization; this is the
// mandatory pull/mailbox mode.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.WAKE_DATA_DIR || './data';
const PORT = Number(process.env.PORT || 7777);

fs.mkdirSync(DATA_DIR, { recursive: true });
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const SUBS_FILE = path.join(DATA_DIR, 'subs.json');

// ---- state ----------------------------------------------------------------
const events = []; // {seq, id, type, source, time, data}
const subs = new Map(); // id -> {id, filter, cursor}
const waiters = new Map(); // subId -> [{resolve, timer}]

if (fs.existsSync(EVENTS_FILE)) {
  for (const line of fs.readFileSync(EVENTS_FILE, 'utf8').split('\n')) {
    if (line.trim()) events.push(JSON.parse(line));
  }
}
if (fs.existsSync(SUBS_FILE)) {
  for (const s of JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'))) subs.set(s.id, s);
}

const saveSubs = () => fs.writeFileSync(SUBS_FILE, JSON.stringify([...subs.values()], null, 2));
const head = () => (events.length ? events[events.length - 1].seq : 0);

const matches = (sub, ev) =>
  !sub.filter?.types?.length || sub.filter.types.includes(ev.type);

const pendingFor = (sub) => events.filter((e) => e.seq > sub.cursor && matches(sub, e));

// The ping must carry the hub's *actual* reachable URL — a cold-started
// agent reconstructs everything from it. Resolved after listen() since
// PORT=0 means "pick an ephemeral port".
let BASE_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const ping = (sub) => ({
  hub: BASE_URL,
  subscription: sub.id,
  cursor: String(sub.cursor),
  pending: pendingFor(sub).length,
});

function notify(ev) {
  for (const sub of subs.values()) {
    if (!matches(sub, ev)) continue;
    const list = waiters.get(sub.id) || [];
    for (const w of list.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(ping(sub));
    }
  }
}

// ---- http -----------------------------------------------------------------
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf ? JSON.parse(buf) : {}));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // POST /events
    if (req.method === 'POST' && url.pathname === '/events') {
      const body = await readBody(req);
      if (!body.type) return json(res, 400, { error: 'type is required' });
      const seq = head() + 1;
      const ev = {
        seq,
        id: `evt_${String(seq).padStart(8, '0')}`,
        type: body.type,
        source: body.source || 'unknown',
        time: new Date().toISOString(),
        data: body.data ?? null,
      };
      events.push(ev);
      fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n');
      notify(ev);
      return json(res, 201, { id: ev.id, seq: ev.seq });
    }

    // GET /events?after=&types=
    if (req.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') || 0);
      const types = url.searchParams.get('types')?.split(',').filter(Boolean);
      const out = events.filter(
        (e) => e.seq > after && (!types?.length || types.includes(e.type)),
      );
      return json(res, 200, { events: out, cursor: String(head()) });
    }

    // GET /subscriptions — the wake rules on this inbox (no event payloads)
    if (req.method === 'GET' && url.pathname === '/subscriptions') {
      return json(res, 200, [...subs.values()]);
    }

    // POST /subscriptions
    if (req.method === 'POST' && url.pathname === '/subscriptions') {
      const body = await readBody(req);
      const id = `sub_${(subs.size + 1).toString(36)}${Math.abs(head() * 2654435761 % 46656).toString(36)}`;
      const sub = {
        id,
        filter: body.filter || {},
        cursor: body.from === 'start' ? 0 : head(),
      };
      subs.set(id, sub);
      saveSubs();
      return json(res, 201, sub);
    }

    // /subscriptions/:id[/wait|/ack]
    if (parts[0] === 'subscriptions' && parts[1]) {
      const sub = subs.get(parts[1]);
      if (!sub) return json(res, 404, { error: 'no such subscription' });

      if (req.method === 'GET' && !parts[2]) return json(res, 200, sub);

      if (req.method === 'GET' && parts[2] === 'wait') {
        if (pendingFor(sub).length > 0) return json(res, 200, ping(sub));
        const timeoutS = Math.min(Number(url.searchParams.get('timeout') || 25), 120);
        const list = waiters.get(sub.id) || waiters.set(sub.id, []).get(sub.id);
        const p = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            list.splice(list.findIndex((w) => w.timer === timer), 1);
            resolve(null);
          }, timeoutS * 1000);
          list.push({ resolve, timer });
        });
        return p ? json(res, 200, p) : json(res, 204);
      }

      if (req.method === 'POST' && parts[2] === 'ack') {
        const body = await readBody(req);
        sub.cursor = Math.max(sub.cursor, Number(body.cursor || 0));
        saveSubs();
        return json(res, 200, sub);
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  const actual = server.address().port;
  if (!process.env.PUBLIC_URL) BASE_URL = `http://localhost:${actual}`;
  console.log(`agent-wake hub listening on http://localhost:${actual}`);
});
