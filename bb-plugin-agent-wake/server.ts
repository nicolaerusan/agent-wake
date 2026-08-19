// bb-plugin-agent-wake — wake BB threads from agent-wake hub events.
//
// A background service long-polls a hub subscription's mailbox (outbound
// connection, NAT-proof). On each thin ping it spawns a thread in the
// configured project whose prompt tells the agent to read its pending
// events from the hub, handle them, and ack its cursor. The plugin holds no
// event state: the hub's cursor is the truth, so a missed or duplicate wake
// is always harmless.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

interface ThinPing {
  hub: string;
  subscription: string;
  cursor: string;
  pending: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });

const needsConfig = (message: string) =>
  Object.assign(new Error(message), { name: "NeedsConfigurationError" });

function wakePrompt(ping: ThinPing, standingInstructions: string): string {
  return [
    `You were woken by an agent-wake ping: new events are waiting for you.`,
    `The ping: ${JSON.stringify(ping)}`,
    ``,
    `Do this now (use curl):`,
    `1. GET ${ping.hub}/subscriptions/${ping.subscription} to read your current cursor and filter.`,
    `2. GET ${ping.hub}/events?after=<cursor> to fetch the pending events.`,
    `3. Handle each event according to the standing instructions below. If there are none, summarize the events for the user.`,
    `4. POST ${ping.hub}/subscriptions/${ping.subscription}/ack with JSON body {"cursor":"<seq of the last event you handled>"}.`,
    `Do not ack events you did not handle. Then stop.`,
    standingInstructions ? `\nStanding instructions:\n${standingInstructions}` : ``,
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hubUrl: {
      type: "string",
      label: "Hub URL",
      default: "http://localhost:7777",
    },
    types: {
      type: "string",
      label: "Event types (comma-separated; empty = all events)",
      default: "",
    },
    project: { type: "project", label: "Project to wake threads in" },
    minIntervalS: {
      type: "string",
      label: "Minimum seconds between wakes",
      default: "30",
    },
    standingInstructions: {
      type: "string",
      label: "Standing instructions for the woken agent",
      default: "",
    },
  });

  const initial = await settings.get();
  if (!initial.project) {
    bb.status.needsConfiguration(
      "Set the project to wake threads in (Settings → Plugins → Agent Wake, or `bb plugin config agent-wake set project <proj_id>`), then reload.",
    );
  }

  async function hubApi<T = any>(
    hubUrl: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const json: any = res.status === 204 ? null : await res.json();
    if (!res.ok) throw new Error(`hub ${res.status}: ${json?.error ?? ""}`);
    return json as T;
  }

  // One durable subscription per (hub, types) pair, remembered in kv. The
  // hub keeps the cursor; if the remembered subscription is gone we make a
  // fresh one from head.
  async function ensureSubscription(
    hubUrl: string,
    types: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = `sub:${hubUrl}|${types}`;
    const existing = await bb.storage.kv.get<string>(key);
    if (existing) {
      try {
        await hubApi(hubUrl, "GET", `/subscriptions/${existing}`, undefined, signal);
        return existing;
      } catch (err) {
        if (signal?.aborted) throw err;
        // fall through: hub lost it (or is a different hub) — resubscribe
      }
    }
    const filter = types
      ? { types: types.split(",").map((t) => t.trim()).filter(Boolean) }
      : {};
    const sub = await hubApi<{ id: string }>(hubUrl, "POST", "/subscriptions", { filter });
    await bb.storage.kv.set(key, sub.id);
    bb.log.info(`subscribed to ${hubUrl} as ${sub.id} (types: ${types || "all"})`);
    return sub.id;
  }

  bb.background.service("watcher", {
    async start(signal) {
      let backoffMs = 1000;
      while (!signal.aborted) {
        const { hubUrl, types, project, minIntervalS, standingInstructions } =
          await settings.get();
        if (!project) {
          throw needsConfig("agent-wake: no project configured to wake threads in.");
        }
        try {
          const subId = await ensureSubscription(hubUrl, types, signal);
          const res = await fetch(
            `${hubUrl}/subscriptions/${subId}/wait?timeout=25`,
            { signal },
          );
          backoffMs = 1000;
          if (res.status !== 200) continue; // 204 quiet timeout — poll again
          const ping = (await res.json()) as ThinPing;

          bb.log.info(`wake: ${ping.pending} pending on ${subId}`);
          const thread = await bb.sdk.threads.spawn({
            projectId: project,
            environment: { type: "project-default" },
            prompt: wakePrompt(ping, standingInstructions),
            title: `Wake: ${ping.pending} event(s) from ${hubUrl}`,
          });
          bb.log.info(`wake: spawned thread ${thread.id}`);

          // Wake economics: events landing during this window coalesce into
          // the next ping, so a chatty source cannot spawn a thread storm.
          await sleep(Math.max(5, Number(minIntervalS) || 30) * 1000, signal);
        } catch (err) {
          if (signal.aborted) return;
          if ((err as Error).name === "NeedsConfigurationError") throw err;
          bb.log.warn(`hub unreachable (${String(err)}); retrying in ${backoffMs}ms`);
          await sleep(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, 60_000);
        }
      }
    },
  });

  bb.cli.register({
    name: "wake",
    summary: "agent-wake hub: emit events, check subscription status",
    commands: [
      {
        name: "emit",
        summary: "Emit an event to the configured hub",
        usage: 'bb wake emit <type> [json-data]  (e.g. bb wake emit task.created \'{"title":"hi"}\')',
      },
      {
        name: "status",
        summary: "Show the configured hub, subscription, and cursor",
        usage: "bb wake status",
      },
    ],
    async run(argv) {
      const { hubUrl, types } = await settings.get();
      const [command, ...rest] = argv;

      if (command === "emit") {
        const [type, data] = rest;
        if (!type) return { exitCode: 1, stderr: "usage: bb wake emit <type> [json-data]" };
        try {
          const out = await hubApi(hubUrl, "POST", "/events", {
            type,
            source: "bb",
            data: data ? JSON.parse(data) : null,
          });
          return { exitCode: 0, stdout: JSON.stringify(out) };
        } catch (err) {
          return { exitCode: 1, stderr: String(err) };
        }
      }

      if (command === "status") {
        const subId = await bb.storage.kv.get<string>(`sub:${hubUrl}|${types}`);
        const subscription = subId
          ? await hubApi(hubUrl, "GET", `/subscriptions/${subId}`).catch((err) => ({
              id: subId,
              error: String(err),
            }))
          : null;
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            { hubUrl, types: types || "(all)", subscription: subscription ?? "none yet — the watcher subscribes on first poll" },
            null,
            2,
          ),
        };
      }

      return { exitCode: 1, stderr: "usage: bb wake <emit|status> …" };
    },
  });

  bb.log.info("agent-wake plugin loaded");
}
