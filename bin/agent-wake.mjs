#!/usr/bin/env node
// agent-wake CLI — one binary over the reference hub + spawner.
//
//   agent-wake hub    [--port N] [--data-dir DIR]
//   agent-wake sub    [--hub URL] [--types a,b] [--from head|start]
//   agent-wake emit   <type> [--hub URL] [--data JSON] [--source S]
//   agent-wake events [--hub URL] [--after N] [--types a,b]
//   agent-wake watch  [--hub URL] [--sub ID] [--types a,b]
//                     (--echo | --claude | --codex | --cmd '...') [-- extra agent args]
//   agent-wake mcp    [--hub URL] [--read-only] [--allow-ack]
//   agent-wake ingest --token SECRET [--hub URL] [--port N] [--github-secret S]
//
// `watch` is the integration point: --echo runs the bundled visible demo,
// --claude wakes `claude -p`, --codex wakes `codex exec`, and --cmd wakes
// anything. If --sub is omitted a subscription is created for you (from head)
// and printed so you can reuse it.

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const [cmd, ...rest] = process.argv.slice(2);

// Everything after a bare `--` is passed through to the agent CLI.
const sep = rest.indexOf('--');
const argv = sep === -1 ? rest : rest.slice(0, sep);
const passthrough = sep === -1 ? [] : rest.slice(sep + 1);

const opts = (options, allowPositionals = false) =>
  parseArgs({ args: argv, options, allowPositionals, strict: true });

const HUB_OPT = { hub: { type: 'string', default: process.env.HUB_URL || 'http://localhost:7777' } };

const api = async (hub, method, path, body) => {
  const res = await fetch(`${hub}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) throw new Error(`hub ${res.status}: ${json.error || JSON.stringify(json)}`);
  return json;
};

// The standard wake prompt for agent CLIs. Deliberately apostrophe-free so it
// survives single-quote shell wrapping.
const WAKE_PROMPT = [
  'You were woken by an agent-wake ping: new events are waiting for you.',
  'The ping JSON is in the WAKE_PING environment variable, shaped like {hub, subscription, cursor, pending}.',
  'Do this now: (1) read WAKE_PING;',
  '(2) GET {hub}/subscriptions/{subscription} to get your current cursor and filter;',
  '(3) GET {hub}/events?after={cursor} to fetch the pending events;',
  '(4) handle each event according to your standing instructions — if you have none, summarize the events;',
  '(5) POST {hub}/subscriptions/{subscription}/ack with JSON body {"cursor":"<seq of the last event you handled>"}.',
  'Then stop. Do not ack events you did not handle.',
].join(' ');

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function usage(code = 0) {
  console.log(`agent-wake — wake agents from events

  agent-wake hub    [--port N] [--data-dir DIR]        run the event hub
  agent-wake sub    [--hub URL] [--types a,b] [--from head|start]
  agent-wake emit   <type> [--hub URL] [--data JSON] [--source S]
  agent-wake events [--hub URL] [--after N] [--types a,b]
  agent-wake watch  [--hub URL] [--sub ID] [--types a,b]
                    (--echo | --claude | --codex | --cmd '...') [-- extra agent args]
  agent-wake mcp    [--hub URL] [--read-only] [--allow-ack]
                                                      MCP server: scan events from any agent
  agent-wake ingest --token SECRET [--port N] [--github-secret S]
                                                      receive webhooks -> events

examples
  agent-wake hub
  agent-wake watch --echo                  # no AI account required
  agent-wake watch --claude                # wake Claude Code on every event
  agent-wake watch --codex --types deploy.finished
  agent-wake watch --cmd 'node my-agent.mjs'
  agent-wake emit task.created --data '{"title":"hello"}'
  agent-wake mcp --read-only               # let an assistant scan, never write
  agent-wake ingest --token hunter2        # curl -H 'X-Wake-Token: hunter2' localhost:7788/hook/ci`);
  process.exit(code);
}

switch (cmd) {
  case 'hub': {
    const { values } = opts({
      port: { type: 'string' },
      'data-dir': { type: 'string' },
    });
    if (values.port) process.env.PORT = values.port;
    if (values['data-dir']) process.env.WAKE_DATA_DIR = values['data-dir'];
    await import(new URL('hub.mjs', ROOT));
    break;
  }

  case 'sub': {
    const { values } = opts({
      ...HUB_OPT,
      types: { type: 'string' },
      from: { type: 'string', default: 'head' },
    });
    const sub = await api(values.hub, 'POST', '/subscriptions', {
      filter: values.types ? { types: values.types.split(',').filter(Boolean) } : {},
      from: values.from,
    });
    console.log(JSON.stringify(sub, null, 2));
    break;
  }

  case 'emit': {
    const { values, positionals } = opts(
      {
        ...HUB_OPT,
        data: { type: 'string' },
        source: { type: 'string', default: 'cli' },
      },
      true,
    );
    const type = positionals[0];
    if (!type) usage(1);
    const out = await api(values.hub, 'POST', '/events', {
      type,
      source: values.source,
      data: values.data ? JSON.parse(values.data) : null,
    });
    console.log(JSON.stringify(out));
    break;
  }

  case 'events': {
    const { values } = opts({
      ...HUB_OPT,
      after: { type: 'string', default: '0' },
      types: { type: 'string' },
    });
    const q = values.types ? `&types=${values.types}` : '';
    const out = await api(values.hub, 'GET', `/events?after=${values.after}${q}`);
    console.log(JSON.stringify(out, null, 2));
    break;
  }

  case 'watch': {
    const { values } = opts({
      ...HUB_OPT,
      sub: { type: 'string' },
      types: { type: 'string' },
      claude: { type: 'boolean', default: false },
      codex: { type: 'boolean', default: false },
      echo: { type: 'boolean', default: false },
      cmd: { type: 'string' },
      'wait-timeout': { type: 'string', default: '25' },
    });

    const extra = passthrough.length ? ' ' + passthrough.map(shellQuote).join(' ') : '';
    let wakeCmd;
    if (values.echo) wakeCmd = `node ${shellQuote(fileURLToPath(new URL('../examples/echo-agent.mjs', import.meta.url)))}`;
    else if (values.cmd) wakeCmd = values.cmd + extra;
    else if (values.claude) wakeCmd = `claude -p ${shellQuote(WAKE_PROMPT)}${extra}`;
    else if (values.codex) wakeCmd = `codex exec ${shellQuote(WAKE_PROMPT)}${extra}`;
    else {
      console.error('watch: pick a target with --echo, --claude, --codex, or --cmd \'...\'');
      process.exit(1);
    }

    let subId = values.sub;
    if (!subId) {
      const sub = await api(values.hub, 'POST', '/subscriptions', {
        filter: values.types ? { types: values.types.split(',').filter(Boolean) } : {},
      });
      subId = sub.id;
      console.log(`watch: created subscription ${subId} (reuse it with --sub ${subId})`);
    }

    process.env.HUB_URL = values.hub;
    process.env.SUB_ID = subId;
    process.env.WAKE_CMD = wakeCmd;
    process.env.WAIT_TIMEOUT_S = values['wait-timeout'];
    await import(new URL('spawner.mjs', ROOT));
    break;
  }

  case 'mcp': {
    // The MCP server parses its own flags (and may be launched directly by a
    // client config), so hand it the argv we were given.
    process.argv = [process.argv[0], 'mcp', ...argv];
    await import(new URL('mcp.mjs', ROOT));
    break;
  }

  case 'ingest': {
    process.argv = [process.argv[0], 'ingest', ...argv];
    await import(new URL('ingest.mjs', ROOT));
    break;
  }

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    usage(cmd === undefined ? 1 : 0);
    break;

  default:
    console.error(`agent-wake: unknown command "${cmd}"`);
    usage(1);
}
