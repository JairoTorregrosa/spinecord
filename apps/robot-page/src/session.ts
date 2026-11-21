// The wiring of the robot page, without a DOM: WebHID device → WebHIDTransport → Ev3Provider → runtime →
// RuntimeClient → relay. It owns one small state machine (the USB device of this page) and publishes a
// snapshot for the view. No robot logic lives here: tools, limits, chunking and the relay protocol belong to
// the packages. Everything it touches is injected (hid, WebSocket, clock), so tests run it with a fake brick
// and a fake relay.
import { USB_PID, USB_VID } from "../../../packages/driver-ev3/encode";
import { Ev3Provider } from "../../../packages/driver-ev3/provider";
import {
  TransportError,
  WebHIDTransport,
  type HidDeviceLike,
  type HidLike,
} from "../../../packages/driver-ev3/transport";
import { RuntimeError } from "../../../packages/protocol/types";
import type { DeviceSpec, Reading, RobotLink, Value } from "../../../packages/protocol/types";
import {
  createRuntimeClient,
  type ClientState,
  type RuntimeClient,
  type RuntimeClientOptions,
  type WebSocketLike,
} from "../../../packages/runtime/client";
import { realClock, type Clock } from "../../../packages/runtime/clock";
import { createRuntime, type LocalRuntime } from "../../../packages/runtime/runtime";
import type { PageConfig } from "./config";

/** navigator.hid: the driver's HidLike plus the plug/unplug events. */
export interface HidApi extends HidLike {
  addEventListener(type: "connect" | "disconnect", listener: (ev: { device: HidDeviceLike }) => void): void;
  removeEventListener(type: "connect" | "disconnect", listener: (ev: { device: HidDeviceLike }) => void): void;
}

/** The USB device as this page holds it. `ready` = opened, scanned and handed to the runtime. */
export type DeviceState = "unsupported" | "none" | "opening" | "ready" | "lost";
export const DEVICE_TRANSITIONS: Record<DeviceState, readonly DeviceState[]> = {
  unsupported: [],
  none: ["opening"],
  opening: ["ready", "none"],
  ready: ["none", "lost"],
  lost: ["opening", "none"],
};

export type ProblemCode =
  | "webhid_unsupported" // this browser has no navigator.hid
  | "device_busy" // open() failed: another program holds the brick
  | "not_ev3"
  | "device_error" // the browser refused the request, or the HID descriptor is not the EV3's
  | "brick_silent" // opened, but the first device scan got no answer
  | "config" // the profile or the EV3 config was rejected by the runtime
  | "relay_refused" // the relay closed the socket on purpose (token, robot id, profile, replaced)
  | "stop_unverified"; // a stop did not confirm that every motor reads speed 0

/** What this page is doing. The relay owns the robot's activity FSM; this is only the local view. */
export type PageActivity = "idle" | "busy" | "stopping";
export type StopWhy = "local" | "hidden" | "pagehide" | "relay" | "heartbeat_lost" | "socket_closed";

export interface ChannelView {
  name: string;
  unit?: string;
  active: boolean;
  value: Value | null;
  error?: string;
}
export interface DeviceView {
  id: string;
  kind: string;
  roles: string[];
  description: string;
  channels: ChannelView[];
}
export interface CallEntry {
  seq: number;
  tool: string;
  reason: string; // the result's reason, "ok", or the error code
  ms: number;
  ok: boolean;
}
export interface Snapshot {
  device: DeviceState;
  deviceName: string | null;
  link: RobotLink;
  linkDetail: string;
  activity: PageActivity;
  tool: string | null; // the relay call in flight, if any
  battery: { voltage_v: number | null; low: boolean | null } | null;
  devices: DeviceView[];
  calls: CallEntry[]; // newest first, at most MAX_CALLS
  problem: { code: ProblemCode; detail: string } | null;
  lastStop: { why: StopWhy; motors_stopped: boolean } | null;
}

export const MAX_CALLS = 20;
export const HIDDEN_STOP_MS = 3000;
/** Close codes the relay uses when it ends a socket on purpose (packages/server CLOSE: refused, replaced, bad frame). */
const TERMINAL_CLOSE = /^code (4001|4002|4003)\b/;

export interface SessionEnv {
  hid?: HidApi; // absent → the browser has no WebHID
  WebSocket?: new (url: string) => WebSocketLike;
  clock?: Clock;
  onChange?: (s: Snapshot) => void;
  hiddenStopMs?: number; // default 3000
  pollMs?: number; // pause between two device reads for the live panel (default 150)
  rescanMs?: number; // how often the ports are re-detected while nothing runs (default 5000)
  reconnectMs?: number; // default 2000
  client?: Partial<Pick<RuntimeClientOptions, "heartbeat_ms" | "heartbeat_timeout_ms">>;
}
export interface Session {
  snapshot(): Snapshot;
  /** Opens the EV3 and goes online. `prompt` shows the browser's device chooser (needs a user gesture). */
  connect(cfg: PageConfig, opts: { prompt: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  /** Brakes every motor from this page, without the relay. Resolves with whether the stop was verified. */
  stop(why?: StopWhy): Promise<boolean>;
  setHidden(hidden: boolean): void;
  pageHide(): void;
  dispose(): void;
}

interface Live {
  device: HidDeviceLike;
  transport: WebHIDTransport;
  runtime: LocalRuntime;
  client: RuntimeClient;
  loop: AbortController;
  inFlight: Map<number, string>; // relay calls running now → tool
  wasOnline: boolean;
}

const isEv3 = (d: HidDeviceLike) => d.vendorId === USB_VID && d.productId === USB_PID;
const message = (e: unknown) => String((e as Error)?.message ?? e);

export function createSession(env: SessionEnv = {}): Session {
  const hid = env.hid;
  const clock = env.clock ?? realClock;
  const hiddenStopMs = env.hiddenStopMs ?? HIDDEN_STOP_MS;
  const pollMs = env.pollMs ?? 150;
  const rescanMs = env.rescanMs ?? 5000;

  let state: DeviceState = hid ? "none" : "unsupported";
  let live: Live | null = null;
  let gen = 0; // one generation per connect; stale callbacks check it
  let lastCfg: PageConfig | null = null;
  let link: RobotLink = "offline";
  let linkDetail = "";
  let stopping = 0;
  let problem: Snapshot["problem"] = hid
    ? null
    : { code: "webhid_unsupported", detail: "navigator.hid is not available" };
  let lastStop: Snapshot["lastStop"] = null;
  let calls: CallEntry[] = [];
  let seq = 0;
  let specs: DeviceSpec[] = [];
  const values = new Map<string, { value: Value | null; error?: string }>();
  let hiddenTimer: AbortController | null = null;
  let disposed = false;
  let tearingDown = false; // between "the session let go of the brick" and "the device is closed"

  const to = (next: DeviceState) => {
    if (!DEVICE_TRANSITIONS[state].includes(next))
      throw new Error(`robot page: illegal device transition ${state} → ${next}`);
    state = next;
  };
  const snapshot = (): Snapshot => {
    const battery = specs.find((d) => d.kind === "battery");
    const read = (id: string, ch: string) => values.get(`${id}.${ch}`)?.value ?? null;
    const volts = battery ? read(battery.id, "voltage_v") : null;
    const low = battery ? read(battery.id, "low") : null;
    return {
      device: state,
      deviceName: live?.device.productName ?? null,
      link,
      linkDetail,
      activity: stopping > 0 ? "stopping" : live && live.inFlight.size > 0 ? "busy" : "idle",
      tool: live ? ([...live.inFlight.values()].at(-1) ?? null) : null,
      battery: battery
        ? { voltage_v: typeof volts === "number" ? volts : null, low: typeof low === "boolean" ? low : null }
        : null,
      devices: specs.map((d) => ({
        id: d.id,
        kind: d.kind,
        roles: d.roles,
        description: d.description,
        channels: d.channels
          .filter((c) => c.type !== "image")
          .map((c) => ({
            name: c.name,
            ...(c.unit ? { unit: c.unit } : {}),
            active: c.active !== false,
            value: values.get(`${d.id}.${c.name}`)?.value ?? null,
            ...(values.get(`${d.id}.${c.name}`)?.error ? { error: values.get(`${d.id}.${c.name}`)!.error } : {}),
          })),
      })),
      calls,
      problem,
      lastStop,
    };
  };
  const emit = () => {
    if (!disposed) env.onChange?.(snapshot());
  };
  const log = (tool: string, reason: string, ms: number, ok: boolean) => {
    calls = [{ seq: ++seq, tool, reason, ms: Math.round(ms), ok }, ...calls].slice(0, MAX_CALLS);
  };
  const setSpecs = (next: DeviceSpec[]) => {
    specs = next;
    const known = new Set(next.flatMap((d) => d.channels.map((c) => `${d.id}.${c.name}`)));
    for (const key of values.keys()) if (!known.has(key)) values.delete(key);
  };

  // The client gets this instead of the runtime, so the page sees the relay's calls. Every member is
  // delegated by name: the runtime is a class instance, spreading it would lose its methods and getters.
  const observe = (rt: LocalRuntime, mine: () => Live | null): LocalRuntime => ({
    backend: rt.backend,
    get stop_worst_ms() {
      return rt.stop_worst_ms;
    },
    profile: () => rt.profile(),
    devices: () => rt.devices(),
    localDevices: () => rt.localDevices(),
    ready: () => rt.ready(),
    refresh: () => rt.refresh(),
    setRemoteProviders: (p) => rt.setRemoteProviders(p),
    onLocalDevicesChanged: (cb) => rt.onLocalDevicesChanged(cb),
    dispose: () => rt.dispose(),
    async stop() {
      stopping++;
      emit();
      try {
        return await rt.stop();
      } finally {
        stopping--;
        emit();
      }
    },
    async call(tool, args, signal, ctx) {
      // Only the relay passes ctx; the client's own battery reads do not belong in the call list.
      const me = mine();
      if (!ctx || !me) return rt.call(tool, args, signal, ctx);
      const id = ++seq;
      const t0 = clock.now();
      me.inFlight.set(id, tool);
      emit();
      try {
        const r = await rt.call(tool, args, signal, ctx);
        const reason = (r.data as { reason?: unknown } | null)?.reason;
        log(tool, typeof reason === "string" ? reason : "ok", clock.now() - t0, true);
        return r;
      } catch (e) {
        log(tool, e instanceof RuntimeError ? e.code : "internal", clock.now() - t0, false);
        throw e;
      } finally {
        me.inFlight.delete(id);
        emit();
      }
    },
  });

  // Live values: one device per tick, in turn, through the runtime's own read tool (reads have no side
  // effects and never switch a sensor mode here). One at a time, because the brick answers one command at
  // a time and a burst of reads would delay a motion chunk.
  const poll = async (me: Live) => {
    let next = 0;
    let lastScan = clock.now();
    const signal = me.loop.signal;
    while (!signal.aborted) {
      await clock.sleep(pollMs, signal);
      if (signal.aborted) return;
      if (me.inFlight.size === 0 && stopping === 0 && clock.now() - lastScan >= rescanMs) {
        // A sensor plugged into an empty port is only seen by a new scan.
        lastScan = clock.now();
        const before = JSON.stringify(me.runtime.localDevices());
        await me.runtime.refresh().catch(() => {});
        if (signal.aborted) return;
        if (JSON.stringify(me.runtime.localDevices()) !== before) void me.client.announceDevices().catch(() => {});
      }
      setSpecs(me.runtime.localDevices());
      const readable = specs.filter((d) => d.channels.some((c) => c.type !== "image"));
      if (readable.length === 0) continue;
      const dev = readable[next++ % readable.length]!;
      try {
        const r = await me.runtime.call("read_device", { device: dev.id }, signal);
        if (signal.aborted) return;
        for (const reading of r.data as Reading[])
          values.set(`${reading.device}.${reading.channel}`, {
            value: reading.value,
            ...(reading.error ? { error: reading.error } : {}),
          });
      } catch (e) {
        if (signal.aborted) return;
        const error = e instanceof RuntimeError ? e.code : message(e);
        for (const c of dev.channels) values.set(`${dev.id}.${c.name}`, { value: null, error });
      }
      emit();
    }
  };

  const teardown = async (next: "none" | "lost", brake: boolean) => {
    const me = live;
    if (!me) return;
    gen++;
    live = null;
    tearingDown = true;
    me.loop.abort();
    try {
      if (brake) await me.runtime.stop().catch(() => {});
      me.client.close(); // final: stops once more and never reconnects
      me.runtime.dispose();
      await me.transport.close().catch(() => {});
    } finally {
      tearingDown = false;
      link = "offline";
      setSpecs([]);
      to(next);
    }
  };

  async function connect(cfg: PageConfig, opts: { prompt: boolean }): Promise<void> {
    if (!hid || state === "unsupported") return emit();
    if (state === "opening" || tearingDown) return; // one connect at a time (a double click, a replug mid-close)
    if (state === "ready") await teardown("none", true);
    lastCfg = cfg;
    problem = null;
    linkDetail = "";
    to("opening");
    const mine = ++gen;
    emit();
    const giveUp = (p: Snapshot["problem"]) => {
      if (mine !== gen) return;
      problem = p;
      to("none");
      emit();
    };

    let device: HidDeviceLike | undefined;
    try {
      device = (await hid.getDevices()).find(isEv3);
      if (!device && opts.prompt)
        device = (await hid.requestDevice({ filters: [{ vendorId: USB_VID, productId: USB_PID }] })).find(isEv3);
    } catch (e) {
      return giveUp({ code: "device_error", detail: message(e) });
    }
    if (!device) return giveUp(null); // nothing granted yet, or the chooser was closed: not an error

    let transport: WebHIDTransport;
    try {
      transport = await WebHIDTransport.open(device);
    } catch (e) {
      // The driver's own errors are typed; a raw exception from open() means another program has the brick.
      const code = !(e instanceof TransportError) ? "device_busy" : e.code === "not_ev3" ? "not_ev3" : "device_error";
      return giveUp({ code, detail: message(e) });
    }

    let runtime: LocalRuntime;
    try {
      const provider = new Ev3Provider(transport, {
        limits: cfg.robot.profile.limits,
        hardware: cfg.robot.hardware,
        pair: cfg.robot.pair,
        roles: cfg.robot.profile.roles,
      });
      runtime = createRuntime({ profile: cfg.robot.profile, providers: [provider], clock });
      await runtime.ready();
    } catch (e) {
      await transport.close().catch(() => {});
      const misconfigured = e instanceof RuntimeError && e.code === "misconfigured";
      return giveUp({ code: misconfigured ? "config" : "brick_silent", detail: message(e) });
    }
    if (mine !== gen) {
      runtime.dispose();
      await transport.close().catch(() => {});
      return;
    }

    let me: Live | null = null;
    let client: RuntimeClient;
    try {
      client = createRuntimeClient({
        runtime: observe(runtime, () => me),
        url: cfg.serverUrl,
        token: cfg.token,
        robot_id: cfg.robotId,
        reconnect_ms: env.reconnectMs ?? 2000,
        clock,
        ...(env.WebSocket ? { WebSocket: env.WebSocket } : {}),
        ...env.client,
        onState: (s, detail) => onClientState(mine, s, detail),
        onEvent: (ev) => {
          if (mine !== gen || ev.kind !== "stopped") return;
          const why: StopWhy =
            ev.detail === "relay stop"
              ? "relay"
              : ev.detail === "relay heartbeat lost"
                ? "heartbeat_lost"
                : "socket_closed";
          // While the relay is unreachable the client stops again on every failed reconnect: show the first.
          if (why === "socket_closed" && !me?.wasOnline) return;
          if (me && why !== "relay") me.wasOnline = false;
          recordStop(why, ev.motors_stopped === true, 0);
          emit();
        },
      });
    } catch (e) {
      runtime.dispose();
      await transport.close().catch(() => {});
      return giveUp({ code: "config", detail: message(e) });
    }
    me = { device, transport, runtime, client, loop: new AbortController(), inFlight: new Map(), wasOnline: false };
    live = me;
    setSpecs(runtime.localDevices());
    to("ready");
    emit();
    client.connect();
    void poll(me);
  }

  const onClientState = (mine: number, s: ClientState, detail: string) => {
    if (mine !== gen || !live) return;
    link = s === "online" ? "online" : s === "handshaking" ? "handshaking" : "offline";
    if (s === "online") {
      live.wasOnline = true;
      if (problem?.code === "relay_refused") problem = null;
    }
    if (s === "closed") {
      linkDetail = detail;
      if (TERMINAL_CLOSE.test(detail)) {
        // Retrying a refusal cannot succeed and would hammer the relay: stop here until the person reconnects.
        problem = { code: "relay_refused", detail };
        live.client.close();
      }
    } else if (s === "online") linkDetail = detail;
    emit();
  };

  const recordStop = (why: StopWhy, motors_stopped: boolean, ms: number) => {
    lastStop = { why, motors_stopped };
    log("stop", motors_stopped ? why : `${why}: stop_unverified`, ms, motors_stopped);
    if (!motors_stopped) problem = { code: "stop_unverified", detail: why };
    else if (problem?.code === "stop_unverified") problem = null;
  };

  async function stop(why: StopWhy = "local"): Promise<boolean> {
    const me = live;
    if (!me) return false; // no brick in this page: nothing it could brake
    stopping++;
    emit();
    const t0 = clock.now();
    let ok = false;
    try {
      ok = (await me.runtime.stop()).motors_stopped;
    } catch {
      ok = false;
    } finally {
      stopping--;
    }
    recordStop(why, ok, clock.now() - t0);
    emit();
    return ok;
  }

  const onUnplug = (ev: { device: HidDeviceLike }) => {
    if (!live || ev.device !== live.device) return;
    // The brick is gone: nothing can be braked. Its motors end by themselves, every operation is time-bounded.
    void teardown("lost", false).then(emit);
  };
  const onPlug = (ev: { device: HidDeviceLike }) => {
    if (state === "lost" && lastCfg && isEv3(ev.device)) void connect(lastCfg, { prompt: false });
  };
  hid?.addEventListener("disconnect", onUnplug);
  hid?.addEventListener("connect", onPlug);

  return {
    snapshot,
    connect,
    stop,
    async disconnect() {
      if (state === "ready") await teardown("none", true);
      else if (state === "lost") to("none");
      emit();
    },
    setHidden(hidden) {
      hiddenTimer?.abort();
      hiddenTimer = null;
      if (!hidden) return;
      const timer = (hiddenTimer = new AbortController());
      void clock.sleep(hiddenStopMs, timer.signal).then(() => {
        if (!timer.signal.aborted && live) void stop("hidden");
      });
    },
    pageHide() {
      // Best effort: the page may be frozen before the brake is sent. The bound on the brick is the guarantee.
      if (live) void stop("pagehide");
    },
    dispose() {
      disposed = true;
      hiddenTimer?.abort();
      hid?.removeEventListener("disconnect", onUnplug);
      hid?.removeEventListener("connect", onPlug);
      if (live) void teardown("none", true);
    },
  };
}
