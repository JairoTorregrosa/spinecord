// Connects a runtime to the relay over WebSocket (CONTRACT.md §8, /ws/robot). Speaks RuntimeToRelay /
// RelayToRuntime only. Owns one small state machine, the connection of this client; the relay owns the
// robot's link, activity and control. Works with the browser's WebSocket and bun's (pass another via options).
import { RuntimeError } from "../protocol/types";
import type {
  BackendKind,
  CommandResult,
  DeviceSpec,
  ErrorCode,
  Provider,
  ProviderState,
  Reading,
  RelayToRuntime,
  RobotTool,
  RuntimeToRelay,
  Value,
} from "../protocol/types";
import { profileHash } from "../protocol/validate";
import { type Clock, realClock } from "./clock";
import { rerr, type LocalRuntime } from "./runtime";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}
export type ClientState = "idle" | "connecting" | "handshaking" | "online" | "closed";
export const CLIENT_TRANSITIONS: Record<ClientState, readonly ClientState[]> = {
  idle: ["connecting"],
  connecting: ["handshaking", "closed"],
  handshaking: ["online", "closed"],
  online: ["closed"],
  closed: ["connecting"],
};
export const HEARTBEAT_MS = 1000; // CONTRACT §8
export const HEARTBEAT_TIMEOUT_MS = 3000; // CONTRACT §0.8: stop the motors after 3 s without relay heartbeat

export interface RuntimeClientOptions {
  runtime: LocalRuntime;
  url: string; // wss://<relay>/ws/robot (?robot_id=<id> is appended when missing)
  token: string;
  robot_id?: string; // default: profile id
  backend?: BackendKind; // default: the runtime's first provider's backend
  fw?: string;
  WebSocket?: new (url: string) => WebSocketLike; // default: globalThis.WebSocket
  clock?: Clock;
  heartbeat_ms?: number;
  heartbeat_timeout_ms?: number;
  organ_read_timeout_ms?: number; // default 2000
  organ_command_timeout_ms?: number; // default: profile max_command_ms + 2000
  organ_stop_timeout_ms?: number; // default 800 (inside the relay's 1 s stop verification)
  reconnect_ms?: number; // when set, reconnect this long after the socket closes (until close() is called)
  onState?: (state: ClientState, detail: string) => void;
  onEvent?: (event: {
    kind: "heartbeat_lost" | "stopped" | "protocol_error" | "organ_error" | "socket_error";
    detail: string;
    motors_stopped?: boolean;
  }) => void;
}
export interface RuntimeClient {
  state(): ClientState;
  connect(): void;
  close(): void; // final: stops the robot, closes the socket, no reconnect
  announceDevices(): Promise<void>; // re-scan local providers and send {t:"devices"}
}

/** Tools that change nothing: repeating one after a deadline abort is safe. Every other tool may have acted. */
const READ_TOOLS: readonly string[] = [
  "describe_robot",
  "describe_device",
  "read_device",
  "read_all",
  "sample_device",
  "wait_until",
];

interface Pending {
  organ_id: string;
  resolve: (m: Extract<RelayToRuntime, { t: "organ_res" }>) => void;
}

export function createRuntimeClient(o: RuntimeClientOptions): RuntimeClient {
  const clock = o.clock ?? realClock;
  const hbMs = o.heartbeat_ms ?? HEARTBEAT_MS;
  const hbTimeout = o.heartbeat_timeout_ms ?? HEARTBEAT_TIMEOUT_MS;
  const WS = o.WebSocket ?? (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!WS) throw rerr("misconfigured", "createRuntimeClient: no WebSocket implementation; pass options.WebSocket");
  if (!o.url || !o.token) throw rerr("misconfigured", "createRuntimeClient: url and token are required");
  const rt = o.runtime;

  let state: ClientState = "idle";
  let ws: WebSocketLike | undefined;
  let gen = 0; // one generation per socket; stale callbacks and loops check it
  let userClosed = false;
  let lastHb = 0;
  let hbLost = false;
  /** the relay's last heartbeat: its own `ts` and when it arrived here; echoed so the relay can measure the round trip */
  let relayHb: { ts: number; at: number } | undefined;
  const organStopMs = o.organ_stop_timeout_ms ?? 800;
  let loop = new AbortController();
  let reqSeq = 0;
  const calls = new Map<string, AbortController>();
  const pending = new Map<string, Pending>();
  const organState = new Map<string, ProviderState>();

  const to = (next: ClientState, detail: string) => {
    if (!CLIENT_TRANSITIONS[state].includes(next))
      throw rerr("internal", `runtime client: illegal transition ${state} → ${next} (${detail})`);
    state = next;
    o.onState?.(next, detail);
  };
  const send = (m: RuntimeToRelay): boolean => {
    if (!ws || (state !== "handshaking" && state !== "online")) return false;
    try {
      ws.send(JSON.stringify(m));
      return true;
    } catch (err) {
      o.onEvent?.({ kind: "socket_error", detail: String(err) });
      return false;
    }
  };

  // ---- organs: a Provider whose reads and commands travel through the relay ----
  const organRequest = (
    organ_id: string,
    body: {
      op: "read" | "command" | "stop";
      device?: string;
      channels?: string[];
      allow_mode_switch?: boolean;
      command?: string;
      args?: Record<string, Value>;
    },
    timeoutMs: number,
    signal?: AbortSignal,
  ) =>
    new Promise<Extract<RelayToRuntime, { t: "organ_res" }> | "aborted">((resolve, reject) => {
      const st = organState.get(organ_id);
      if (st !== "active" && st !== "announced")
        return reject(
          rerr(
            "provider_stale",
            `Device provider "${organ_id}" is ${st ?? "gone"} (not heard from in 3 s). Retry shortly, or call describe_robot to see what is attached.`,
          ),
        );
      const req_id = `q${gen}-${++reqSeq}`;
      const done = new AbortController();
      const finish = (fn: () => void) => {
        pending.delete(req_id);
        done.abort();
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => finish(() => resolve("aborted"));
      pending.set(req_id, { organ_id, resolve: (m) => finish(() => resolve(m)) });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!send({ t: "organ_req", req_id, organ_id, ...body }))
        return finish(() =>
          reject(rerr("robot_offline", `Cannot reach "${organ_id}": the runtime is not connected to the relay.`)),
        );
      void clock.sleep(timeoutMs, done.signal).then(() => {
        if (!done.signal.aborted)
          finish(() =>
            reject(
              rerr(
                "timeout",
                `"${organ_id}" did not answer ${body.op}${body.device ? " on " + body.device : ""} within ${timeoutMs} ms.`,
              ),
            ),
          );
      });
    });
  const failIfError = (res: Extract<RelayToRuntime, { t: "organ_res" }>, what: string) => {
    if (!res.ok)
      throw rerr(res.error?.code ?? "internal", res.error?.message ?? `${what} failed without an error message`);
  };
  const organProvider = (organ_id: string, devices: DeviceSpec[]): Provider => ({
    id: organ_id,
    backend: "organ",
    stop_worst_ms: organStopMs,
    devices: async () => devices,
    async read(device, channels, opts) {
      const res = await organRequest(
        organ_id,
        { op: "read", device, channels, ...(opts?.allow_mode_switch ? { allow_mode_switch: true } : {}) },
        o.organ_read_timeout_ms ?? 2000,
      );
      if (res === "aborted") return [];
      failIfError(res, `read ${device}`);
      if (!Array.isArray(res.data))
        throw rerr("internal", `"${organ_id}" answered read ${device} with data that is not a list of readings`);
      return res.data as Reading[];
    },
    async command(device, command, args, signal) {
      const t0 = clock.now();
      const res = await organRequest(
        organ_id,
        { op: "command", device, command, args },
        o.organ_command_timeout_ms ?? rt.profile().limits.max_command_ms + 2000,
        signal,
      );
      if (res === "aborted")
        return { requested: args, measured: {}, clamped: false, reason: "preempted", ms: Math.round(clock.now() - t0) };
      failIfError(res, `${command} on ${device}`);
      const d = res.data as Partial<CommandResult> | undefined;
      if (!d || typeof d.reason !== "string")
        throw rerr(
          "internal",
          `"${organ_id}" answered ${command} on ${device} without a command result {requested, measured, clamped, reason, ms}`,
        );
      return {
        requested: d.requested ?? args,
        measured: d.measured ?? {},
        clamped: d.clamped === true,
        reason: d.reason,
        ms: typeof d.ms === "number" ? d.ms : Math.round(clock.now() - t0),
      };
    },
    // Drops what is in flight for this organ, then asks it to stop and reports what it verified.
    // An organ without moving commands has nothing to brake and is not asked.
    async stop() {
      for (const [id, p] of pending)
        if (p.organ_id === organ_id)
          p.resolve({
            t: "organ_res",
            req_id: id,
            ok: false,
            error: { code: "robot_offline", message: `request to "${organ_id}" was dropped by stop` },
          });
      if (!devices.some((d) => d.commands.some((c) => c.moves))) return { motors_stopped: true };
      try {
        const res = await organRequest(organ_id, { op: "stop" }, organStopMs);
        return {
          motors_stopped:
            res !== "aborted" &&
            res.ok &&
            (res.data as { motors_stopped?: unknown } | undefined)?.motors_stopped === true,
        };
      } catch {
        return { motors_stopped: false };
      } // silent, stale or unreachable: not verified
    },
  });

  // ---- relay messages ----
  const runCall = async (m: Extract<RelayToRuntime, { t: "call" }>) => {
    if (calls.has(m.call_id)) return; // the relay deduplicates; a repeated id is already running
    const ctl = new AbortController();
    calls.set(m.call_id, ctl);
    const timer = new AbortController();
    let timedOut = false;
    // deadline_ms is a duration; an epoch timestamp is accepted too. It is the relay's backstop (the tool's budget
    // plus a margin): the runtime's own limits end a call first and answer with data. A call that still reaches it
    // is aborted and answered as an error; if it may have acted, repeating it is not safe, so it is not retryable.
    const budget = m.deadline_ms > 1e11 ? m.deadline_ms - clock.now() : m.deadline_ms;
    if (budget > 0)
      void clock.sleep(budget, timer.signal).then(() => {
        if (!timer.signal.aborted) {
          timedOut = true;
          ctl.abort();
        }
      });
    let out: RuntimeToRelay;
    try {
      const r = await rt.call(m.tool as RobotTool, m.args ?? {}, ctl.signal, { activity: m.activity });
      out = timedOut
        ? {
            t: "result",
            call_id: m.call_id,
            ok: false,
            error: {
              code: "timeout",
              message: `${m.tool} exceeded its deadline of ${Math.round(budget)} ms and was aborted.${READ_TOOLS.includes(m.tool) ? "" : " It may have acted: read the robot before acting again."} Partial result: ${JSON.stringify(r.data).slice(0, 600)}`,
              retryable: READ_TOOLS.includes(m.tool),
            },
          }
        : { t: "result", call_id: m.call_id, ok: true, data: r.data, ...(r.image ? { image: r.image } : {}) };
    } catch (err) {
      const e = err instanceof RuntimeError ? err : rerr("internal", String((err as Error)?.message ?? err));
      out = {
        t: "result",
        call_id: m.call_id,
        ok: false,
        error: { code: e.code as ErrorCode, message: e.message, retryable: e.retryable },
      };
    }
    timer.abort();
    calls.delete(m.call_id);
    send(out);
  };

  const stopNow = async (why: string) => {
    for (const c of calls.values()) c.abort();
    let motors_stopped = false;
    try {
      motors_stopped = (await rt.stop()).motors_stopped;
    } catch {
      motors_stopped = false;
    }
    o.onEvent?.({ kind: "stopped", detail: why, motors_stopped });
    return motors_stopped;
  };

  const onMessage = async (raw: unknown) => {
    let m: RelayToRuntime;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : String(raw)) as RelayToRuntime;
    } catch {
      o.onEvent?.({ kind: "protocol_error", detail: "relay sent a message that is not JSON" });
      return;
    }
    lastHb = clock.now(); // any relay message proves the relay is alive
    hbLost = false;
    switch (m.t) {
      case "welcome":
        if (state === "handshaking") to("online", `session ${m.session_id}`);
        return;
      case "hb":
        if (typeof m.ts === "number") relayHb = { ts: m.ts, at: clock.now() };
        return;
      case "call":
        void runCall(m);
        return;
      case "abort":
        calls.get(m.call_id)?.abort();
        return;
      case "stop": {
        send({ t: "stopped", stop_id: m.stop_id, motors_stopped: await stopNow("relay stop") });
        return;
      }
      case "organs": {
        organState.clear();
        for (const g of m.organs) organState.set(g.organ_id, g.state);
        await rt
          .setRemoteProviders(
            m.organs.filter((g) => g.state !== "gone").map((g) => organProvider(g.organ_id, g.devices)),
          )
          .catch((err) => o.onEvent?.({ kind: "organ_error", detail: String((err as Error)?.message ?? err) })); // also in describe_robot.provider_errors
        return;
      }
      case "organ_res":
        pending.get(m.req_id)?.resolve(m);
        return;
      default:
        o.onEvent?.({
          kind: "protocol_error",
          detail: `unknown relay message type ${String((m as { t?: unknown }).t)}`,
        });
    }
  };

  // battery_low = any device of kind battery reports low=true. Read in the background and cached: the
  // heartbeat and the watchdog below never wait on a provider (a hung brick read must not delay the stop).
  let batteryLow: boolean | undefined;
  let batteryBusy = false;
  const refreshBattery = () => {
    const ids = rt
      .devices()
      .filter((d) => d.kind === "battery" && d.channels.some((c) => c.name === "low" && c.active !== false))
      .map((d) => d.id);
    if (!ids.length) {
      batteryLow = undefined;
      return;
    }
    if (batteryBusy) return;
    batteryBusy = true;
    Promise.all(
      ids.map((device) =>
        rt.call("read_device", { device, channels: ["low"] }, new AbortController().signal).then(
          (r) => (r.data as Reading[])[0]?.value,
          () => null,
        ),
      ),
    )
      .then((vals) => {
        batteryLow = vals.includes(true) ? true : vals.every((v) => v === false) ? false : undefined;
      })
      .finally(() => {
        batteryBusy = false;
      });
  };

  const heartbeats = async (mine: number, signal: AbortSignal) => {
    refreshBattery();
    while (mine === gen && !signal.aborted) {
      await clock.sleep(hbMs, signal);
      if (mine !== gen || signal.aborted) return;
      send({
        t: "hb",
        ts: clock.now(),
        ...(batteryLow === undefined ? {} : { battery_low: batteryLow }),
        ...(relayHb ? { echo: { ts: relayHb.ts, held_ms: Math.round(clock.now() - relayHb.at) } } : {}),
      });
      refreshBattery();
      if (!hbLost && clock.now() - lastHb >= hbTimeout) {
        hbLost = true;
        o.onEvent?.({ kind: "heartbeat_lost", detail: `no relay message for ${Math.round(clock.now() - lastHb)} ms` });
        const sock = ws;
        void stopNow("relay heartbeat lost").then(() => {
          if (mine === gen) sock?.close(4000, "heartbeat lost");
        }); // a half-dead socket is replaced by a fresh one
      }
    }
  };

  const onClose = async (mine: number, detail: string) => {
    if (mine !== gen || state === "closed" || state === "idle") return;
    gen++;
    loop.abort();
    to("closed", detail);
    for (const [id, p] of pending) {
      pending.delete(id);
      p.resolve({
        t: "organ_res",
        req_id: id,
        ok: false,
        error: { code: "robot_offline", message: "relay connection closed before the device answered" },
      });
    }
    if (!hbLost) await stopNow(`socket closed: ${detail}`); // already stopped when the heartbeat was lost
    if (!userClosed && o.reconnect_ms !== undefined) {
      await clock.sleep(o.reconnect_ms);
      if (!userClosed && (state as ClientState) === "closed") connect();
    }
  };

  function connect(): void {
    if (state !== "idle" && state !== "closed") return;
    userClosed = false;
    to("connecting", o.url);
    const mine = ++gen;
    loop = new AbortController();
    hbLost = false;
    relayHb = undefined;
    // The relay routes by the robot_id query parameter (/ws/robot?robot_id=<id>).
    const robotId = o.robot_id ?? rt.profile().id;
    const url = /[?&]robot_id=/.test(o.url)
      ? o.url
      : `${o.url}${o.url.includes("?") ? "&" : "?"}robot_id=${encodeURIComponent(robotId)}`;
    const sock = new WS!(url);
    ws = sock;
    sock.onopen = () => {
      void rt.ready().then(
        () => {
          if (mine !== gen) return;
          to("handshaking", "socket open");
          lastHb = clock.now();
          send({
            t: "hello",
            v: 2,
            robot_id: o.robot_id ?? rt.profile().id,
            token: o.token,
            backend: o.backend ?? rt.backend,
            profile: rt.profile(),
            profile_hash: profileHash(rt.profile()),
            devices: rt.localDevices(),
            stop_worst_ms: Math.max(rt.stop_worst_ms, organStopMs + 50),
            ...(o.fw ? { fw: o.fw } : {}),
          });
          void heartbeats(mine, loop.signal);
        },
        (err) => {
          o.onEvent?.({
            kind: "protocol_error",
            detail: `runtime not ready: ${String((err as Error)?.message ?? err)}`,
          });
          sock.close(4001, "runtime not ready");
        },
      );
    };
    sock.onmessage = (ev) => {
      if (mine === gen) void onMessage(ev?.data);
    };
    sock.onerror = (ev) => o.onEvent?.({ kind: "socket_error", detail: String(ev?.message ?? "websocket error") });
    sock.onclose = (ev) => void onClose(mine, `code ${ev?.code ?? "?"} ${ev?.reason ?? ""}`.trim());
  }

  // A provider reported a device change (hot-plug): the registry is already re-read, tell the relay.
  rt.onLocalDevicesChanged(() => void send({ t: "devices", devices: rt.localDevices() }));

  return {
    state: () => state,
    connect,
    close() {
      userClosed = true;
      const sock = ws;
      const mine = gen;
      if (state === "idle" || state === "closed") return;
      void onClose(mine, "closed by the runtime");
      try {
        sock?.close(1000, "closed by the runtime");
      } catch {
        /* already closed */
      }
    },
    async announceDevices() {
      await rt.refresh();
      send({ t: "devices", devices: rt.localDevices() });
    },
  };
}
