// The kit of the peripheral page (CONTRACT §2.4): the device registry behind `spinecord.device()`, the socket, the
// hello, the answer to pings, reads and commands, pushes, pause and stop lending, and joining again after the socket
// closed. DOM-free: the browser end comes in through KitOptions, so a test runs it against a fake socket or a real
// listener.
//   idle ─start()→ joining ─welcome→ lending ⇄ paused
//   lending, paused ─socket closed→ reconnecting ─backoff→ joining (the same name and token) ─welcome→ lending
//   any ─closed by the page, a refused hello, a first join that failed, or 30 s away→ closed
// Two things run on a timer: the coalescing of pushes over 20 per second, and the backoff of joining again. Pings,
// reads and commands are answered from the socket's message handler, which a browser runs at once even in a hidden
// tab.
import type {
  ChannelSpec,
  CommandSpec,
  ErrorCode,
  PageDevice,
  PageToServer,
  PageUnavailable,
  Scalar,
  ServerToPage,
  StopReason,
  Value,
} from "../../../packages/protocol/types";

/** A frame an image channel's read returns: the encoded bytes and when they were captured, on the page's clock. */
export interface Frame {
  mime: "image/jpeg" | "image/png";
  bytes: Uint8Array;
  captured_at: number;
}
/** What a command's `run` resolves with: its measured values, or `ended(...)` for a reason other than completed. */
export type Measured = Record<string, Value>;
export interface Ended {
  readonly [ENDED]: true;
  measured: Measured;
  reason: StopReason;
}
const ENDED = Symbol("spinecord.ended");
/** A command that ended for another reason than completing: `timeout`, `preempted`, `clamped`... */
export const ended = (reason: StopReason, measured: Measured = {}): Ended => ({ [ENDED]: true, measured, reason });

/** An error a device throws to answer a request with a contract code. Any other error answers `internal`. */
export class PageError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const PAGE_CODES: readonly ErrorCode[] = [
  "invalid_argument",
  "unsupported",
  "busy",
  "timeout",
  "device_offline",
  "unknown_channel",
  "unknown_command",
  "internal",
];

/** One device, as `spinecord.device()` takes it (docs/peripheral-pages.md). */
export interface DeviceDef {
  id: string;
  kind: string;
  description: string;
  roles?: string[];
  channels: ChannelSpec[];
  commands: CommandSpec[];
  /** true, or why the device cannot be lent; asked each time the manifest is built. */
  available?: () => true | string;
  /** Values of the channels that are not pushed. An image channel's value is a Frame. */
  read?: (channels: string[]) => Record<string, Value | Frame | null> | Promise<Record<string, Value | Frame | null>>;
  /** Runs one command; resolves when it has ended. */
  run?: (
    command: string,
    args: Record<string, Value>,
    signal: AbortSignal,
  ) => Measured | Ended | Promise<Measured | Ended>;
  /** The robot's stop: end whatever the device is doing. */
  stop?: () => void;
}

/** The browser socket, as much of it as the kit uses (a WebSocket fits). */
export interface SocketLike {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "message",
    cb: (ev: { data?: unknown; code?: number; reason?: string }) => void,
  ): void;
}

export type KitState = "idle" | "joining" | "lending" | "paused" | "reconnecting" | "closed";
export interface KitStatus {
  state: KitState;
  /** The robot and page name the process welcomed. */
  robot: string | null;
  name: string;
  /** Close code and reason, once closed. */
  closed: { code: number; reason: string } | null;
  /** While the page joins again: how many tries so far, since when it is away, and why its socket closed. */
  rejoin: { attempt: number; since: number; code: number; reason: string } | null;
  /** The person paused lending; a pause outlives a socket that closes and is said again after the welcome. */
  held: boolean;
  /** Devices that are down, and why. */
  down: Record<string, string>;
  /** Ids of the devices announced, and what could not be lent. */
  devices: string[];
  unavailable: PageUnavailable[];
}
/** What a request did, for the page's banner: a frame was taken, a command started or ended. */
export type KitActivity =
  | { t: "frame"; device: string; at: number }
  | { t: "command"; device: string; command: string; phase: "start" | "end" };

export interface KitOptions {
  /** ws://<host>/page */
  url: string;
  token: string;
  openSocket(url: string): SocketLike;
  /** document.visibilityState === "visible" */
  visible(): boolean;
  now?: () => number;
  onStatus?: (s: KitStatus) => void;
  onActivity?: (a: KitActivity) => void;
  /** Runs before each try to join again; its hello goes once it settles (the page takes its media back first). */
  beforeRejoin?: () => Promise<void>;
  /** Overrides of REJOIN (tests). */
  rejoin?: Partial<{ delays_ms: number[]; window_ms: number; prepare_ms: number }>;
}

/**
 * Joining again after the socket closed (CONTRACT §2.4, Sleep): the waits between tries, the last one repeated, and
 * how long the process keeps a page's place after its socket closed (PAGE_TIMES.gone_ms in apps/local). The page
 * hears no `gone`: it counts that time on its own clock, from when it saw the close.
 */
export const REJOIN = {
  delays_ms: [500, 1000, 2000, 5000],
  window_ms: 30_000,
  /** At most this long for beforeRejoin (a getUserMedia that never settles): the hello then lends what there is. */
  prepare_ms: 3000,
} as const;
/** Close codes after which a hello cannot be accepted again: the process ends, or it refused this page's hello. */
const FINAL_CLOSE: ReadonlySet<number> = new Set([1001, 4000, 4001, 4004, 4008, 4010, 4029]);

const PUSHES_PER_S = 20;
const STATE: Record<KitState, readonly KitState[]> = {
  idle: ["joining", "closed"],
  // reconnecting from joining only when the page is joining again: a first join that fails is closed
  joining: ["lending", "reconnecting", "closed"],
  lending: ["paused", "reconnecting", "closed"],
  paused: ["lending", "reconnecting", "closed"],
  reconnecting: ["joining", "closed"],
  closed: [],
};

/** The fields a manifest carries: everything of a DeviceDef but its functions. */
function spec(d: DeviceDef): PageDevice {
  return {
    id: d.id,
    kind: d.kind,
    description: d.description,
    roles: [...(d.roles ?? [])],
    channels: d.channels.map((c) => ({ ...c })),
    commands: d.commands.map((c) => ({ ...c })),
  };
}

function fits(c: ChannelSpec, v: unknown): boolean {
  if (v === null) return c.null_when_absent === true;
  if (c.type === "number") return typeof v === "number" && Number.isFinite(v);
  return typeof v === c.type;
}

export interface Kit {
  device(def: DeviceDef): void;
  push(id: string, values: Record<string, Scalar | null>): void;
  /** Opens the socket and sends the hello under this page name: call it from the person's tap. */
  start(join: { name: string; robot?: string }): void;
  /** The manifest as it would be sent now. */
  manifest(): { devices: PageDevice[]; unavailable: PageUnavailable[] };
  /** Sends the manifest again (a device was added, changed or withdrawn). */
  announce(): void;
  /** Sends the manifest again if it differs from the one the process has (a track came back). No-op until welcomed. */
  reconcile(): void;
  /** The person stopped lending this device: it leaves the manifest, with why in `unavailable`. */
  withdraw(id: string, why: string): void;
  /** A device cannot work for the moment (its track was muted), and works again. Said again after each welcome. */
  down(id: string, why: string): void;
  up(id: string): void;
  pause(why?: string): void;
  resume(): void;
  /** While reconnecting: try at once, without the rest of the wait (the page is visible again). */
  reconnectNow(): void;
  /** Ends every command in flight and calls each device's stop. */
  stopAll(): void;
  status(): KitStatus;
  close(): void;
}

export function createKit(o: KitOptions): Kit {
  const now = o.now ?? (() => Date.now());
  const defs = new Map<string, DeviceDef>();
  const withdrawn = new Map<string, PageUnavailable>();
  let announced = new Map<string, PageDevice>();
  let unavailable: PageUnavailable[] = [];
  const latest = new Map<string, Record<string, Scalar | null>>(); // device → every pushed value, for the welcome
  const rate = new Map<string, { times: number[]; held: Record<string, Scalar | null> | null }>();
  const running = new Map<number, { device: string; ac: AbortController }>();
  const downs = new Map<string, string>(); // device → why it is down, said again after each welcome
  const delays = o.rejoin?.delays_ms ?? REJOIN.delays_ms;
  const windowMs = o.rejoin?.window_ms ?? REJOIN.window_ms;
  const prepareMs = o.rejoin?.prepare_ms ?? REJOIN.prepare_ms;
  let ws: SocketLike | null = null;
  let state: KitState = "idle";
  let robot: string | null = null;
  let closed: KitStatus["closed"] = null;
  let name = "";
  let wantRobot: string | undefined;
  let held: { why?: string } | null = null;
  /** Set from the first close after a welcome until the next welcome: the page is away. */
  let away: { since: number; attempt: number; code: number; reason: string } | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let trying = false;
  let closing = false;

  const status = (): KitStatus => ({
    state,
    robot,
    name,
    closed,
    rejoin: away ? { attempt: away.attempt, since: away.since, code: away.code, reason: away.reason } : null,
    held: held !== null,
    down: Object.fromEntries(downs),
    devices: [...announced.keys()],
    unavailable: [...unavailable],
  });
  const to = (next: KitState) => {
    if (next === state) return;
    if (!STATE[state].includes(next)) throw new Error(`peripheral page: illegal transition ${state} → ${next}`);
    state = next;
    o.onStatus?.(status());
  };
  const send = (m: PageToServer) => ws?.send(JSON.stringify(m));
  const joined = () => state === "lending" || state === "paused";

  function manifest(): { devices: PageDevice[]; unavailable: PageUnavailable[] } {
    const devices: PageDevice[] = [];
    const out: PageUnavailable[] = [];
    for (const d of defs.values()) {
      const w = withdrawn.get(d.id);
      if (w) {
        out.push(w);
        continue;
      }
      const ok = d.available ? d.available() : true;
      if (ok === true) devices.push(spec(d));
      else out.push({ kind: d.kind, why: `${d.kind}: ${ok}`.slice(0, 300) });
    }
    return { devices, unavailable: out };
  }
  const take = (m: ReturnType<typeof manifest>) => {
    announced = new Map(m.devices.map((d) => [d.id, d]));
    unavailable = m.unavailable;
  };

  function sendState(device: string, values: Record<string, Scalar | null>): void {
    const r = rate.get(device) ?? { times: [], held: null };
    rate.set(device, r);
    const t = now();
    r.times = r.times.filter((x) => t - x < 1000);
    if (r.times.length >= PUSHES_PER_S) {
      // over the rate: keep the latest values and send them once the second has room
      const first = r.held === null;
      r.held = { ...r.held, ...values };
      if (first)
        setTimeout(
          () => {
            const held = r.held;
            r.held = null;
            if (held && joined() && announced.has(device)) sendState(device, held);
          },
          1000 - (t - r.times[0]!),
        );
      return;
    }
    r.times.push(t);
    send({ t: "state", device, values });
  }

  async function onRequest(m: Extract<ServerToPage, { t: "req" }>): Promise<void> {
    if (m.op === "stop") {
      stopAll();
      return send({ t: "res", id: m.id, ok: true });
    }
    if (m.op === "abort") {
      running.get(m.of)?.ac.abort();
      return;
    }
    const fail = (code: ErrorCode, message: string) =>
      send({ t: "res", id: m.id, ok: false, error: { code, message: message.slice(0, 300) } });
    const def = defs.get(m.device);
    const announcedSpec = announced.get(m.device);
    if (!def || !announcedSpec) return fail("device_offline", `this page does not lend ${m.device}`);
    if (state === "paused") return fail("device_offline", "the person at the page paused lending");
    const failWith = (e: unknown) => {
      if (e instanceof PageError && PAGE_CODES.includes(e.code)) fail(e.code, e.message);
      else fail("internal", e instanceof Error ? e.message : String(e));
    };
    if (m.op === "read") {
      try {
        if (!def.read) return fail("unknown_channel", `${m.device} reports its channels by itself`);
        const values = await def.read(m.channels);
        const readings: Record<string, Value | null> = {};
        let frame: { channel: string; frame: Frame } | null = null;
        for (const c of m.channels) {
          const v = values[c];
          const ch = announcedSpec.channels.find((x) => x.name === c);
          if (ch?.type === "image") {
            if (v && typeof v === "object" && "bytes" in v) frame = { channel: c, frame: v };
            continue;
          }
          readings[c] = v === undefined ? null : (v as Value | null);
        }
        if (!frame) return send({ t: "res", id: m.id, ok: true, readings });
        const { bytes, mime, captured_at } = frame.frame;
        o.onActivity?.({ t: "frame", device: m.device, at: captured_at });
        send({
          t: "res",
          id: m.id,
          ok: true,
          readings,
          image: {
            channel: frame.channel,
            mime,
            bytes: bytes.length,
            age_ms: Math.max(0, Math.round(now() - captured_at)),
          },
        });
        ws?.send(bytes);
      } catch (e) {
        failWith(e);
      }
      return;
    }
    // a command
    if (!def.run || !announcedSpec.commands.some((c) => c.name === m.command))
      return fail("unknown_command", `${m.device} has no command ${m.command}`);
    const ac = new AbortController();
    running.set(m.id, { device: m.device, ac });
    o.onActivity?.({ t: "command", device: m.device, command: m.command, phase: "start" });
    try {
      const r = await def.run(m.command, m.args, ac.signal);
      const result =
        r && typeof r === "object" && ENDED in r
          ? { measured: r.measured, reason: r.reason }
          : { measured: r as Measured, reason: (ac.signal.aborted ? "preempted" : "completed") as StopReason };
      send({ t: "res", id: m.id, ok: true, result });
    } catch (e) {
      failWith(e);
    } finally {
      running.delete(m.id);
      o.onActivity?.({ t: "command", device: m.device, command: m.command, phase: "end" });
    }
  }

  function onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    const m = JSON.parse(data) as ServerToPage;
    if (m.t === "ping") return send({ t: "pong", n: m.n, visible: o.visible() });
    if (m.t === "welcome") {
      robot = m.robot;
      away = null;
      if (retry) clearTimeout(retry);
      retry = null;
      to("lending");
      // what changed between the hello and the welcome (a camera taken back meanwhile brings its torch, a permission
      // taken back withdraws it), before any value of a device the process may not have
      kit.reconcile();
      // every pushed channel has a value from the start: a read before the first push is an error otherwise
      for (const [device, values] of latest) if (announced.has(device)) sendState(device, values);
      // a page that joined again starts afresh on the process: what is down and the person's pause are said again
      for (const [device, why] of downs) if (announced.has(device)) send({ t: "down", device, why });
      if (held) {
        send({ t: "paused", ...(held.why ? { why: held.why } : {}) });
        to("paused");
      }
      return;
    }
    if (m.t === "req") void onRequest(m);
  }

  function stopAll(): void {
    for (const r of running.values()) r.ac.abort();
    for (const d of defs.values()) d.stop?.();
  }

  /** Opens a socket and sends the hello with the manifest as it is at that moment. */
  function connect(): void {
    to("joining");
    take(manifest());
    const sock = o.openSocket(o.url);
    ws = sock;
    sock.binaryType = "arraybuffer";
    // events of a socket that is not the page's one any more say nothing
    sock.addEventListener("open", () => {
      if (sock !== ws) return;
      send({
        t: "hello",
        v: 1,
        token: o.token,
        ...(wantRobot ? { robot: wantRobot } : {}),
        name,
        devices: [...announced.values()],
        unavailable,
      });
    });
    sock.addEventListener("message", (ev) => sock === ws && onMessage(ev.data));
    sock.addEventListener("close", (ev) => sock === ws && onClose(ev.code ?? 1006, ev.reason ?? ""));
    // a try that hangs in its handshake or before its welcome still ends with the window
    if (away) {
      const left = away.since + windowMs - now();
      retry = setTimeout(
        () => {
          retry = null;
          if (state !== "joining" || ws !== sock) return;
          ws = null;
          sock.close(1000, "the page gave up joining again");
          stopAll();
          giveUp();
        },
        Math.max(0, left),
      );
    }
  }

  function end(code: number, reason: string): void {
    if (retry) clearTimeout(retry);
    retry = null;
    away = null;
    closed = { code, reason };
    to("closed");
  }

  function onClose(code: number, reason: string): void {
    ws = null;
    if (retry) clearTimeout(retry);
    retry = null;
    stopAll();
    // a page that was never welcomed has no place to take back
    const welcomed = away !== null || state === "lending" || state === "paused";
    if (closing || !welcomed || FINAL_CLOSE.has(code)) return end(code, reason);
    const t = now();
    away = { since: away?.since ?? t, attempt: away?.attempt ?? 0, code, reason };
    if (t - away.since >= windowMs) return giveUp();
    to("reconnecting");
    schedule();
  }

  function giveUp(): void {
    const last = away ? ` (the last close: code ${away.code}${away.reason ? `, ${away.reason}` : ""})` : "";
    end(
      away?.code ?? 1006,
      `The page could not join again within ${Math.round(windowMs / 1000)} s, so the robot let its place go${last}`.slice(
        0,
        300,
      ),
    );
  }

  function schedule(): void {
    if (!away) return;
    const wait = delays[Math.min(away.attempt, delays.length - 1)] ?? 0;
    const left = away.since + windowMs - now();
    retry = setTimeout(() => void attempt(), Math.max(0, Math.min(wait, left)));
  }

  async function attempt(): Promise<void> {
    retry = null;
    if (state !== "reconnecting" || trying || !away) return;
    // a frozen page runs no timer: the window is counted on the clock, whenever this runs
    if (now() - away.since >= windowMs) return giveUp();
    trying = true;
    let cap: ReturnType<typeof setTimeout> | undefined;
    try {
      const left = away.since + windowMs - now();
      let settled = false;
      const prepared = (o.beforeRejoin?.() ?? Promise.resolve()).catch(() => {}).then(() => void (settled = true));
      await Promise.race([prepared, new Promise((r) => (cap = setTimeout(r, Math.max(0, Math.min(prepareMs, left)))))]);
      // what it took back after the hello went out is announced then, or at the welcome
      if (!settled) void prepared.then(() => kit.reconcile());
    } finally {
      clearTimeout(cap);
      trying = false;
    }
    if (state !== "reconnecting" || !away) return;
    if (now() - away.since >= windowMs) return giveUp();
    away.attempt++;
    connect();
  }

  const kit: Kit = {
    device(def) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(def.id))
        throw new Error(`spinecord.device: id "${def.id}" must match ^[a-z][a-z0-9_]{0,31}$`);
      defs.set(def.id, def);
      withdrawn.delete(def.id);
      if (joined()) kit.announce();
    },
    push(id, values) {
      const def = defs.get(id);
      if (!def) throw new Error(`spinecord.push: no device "${id}"`);
      for (const [c, v] of Object.entries(values)) {
        const ch = def.channels.find((x) => x.name === c);
        if (!ch || ch.pushed !== true) throw new Error(`spinecord.push: ${id}.${c} is not a pushed channel`);
        if (!fits(ch, v)) throw new Error(`spinecord.push: ${id}.${c} must be a ${ch.type}`);
      }
      latest.set(id, { ...latest.get(id), ...values });
      if (joined() && announced.has(id)) sendState(id, values);
    },
    start(join) {
      if (state !== "idle") throw new Error(`peripheral page: start() while ${state}`);
      name = join.name;
      wantRobot = join.robot;
      connect();
    },
    manifest,
    announce() {
      // between a hello and its welcome, `announced` stays what that hello carried: the welcome reconciles the rest
      if (state === "joining" || state === "reconnecting") return void o.onStatus?.(status());
      const before = new Set(announced.keys());
      const m = manifest();
      take(m);
      if (joined()) {
        send({ t: "devices", devices: m.devices, unavailable: m.unavailable });
        // a device the process did not have: its pushed values and whether it is down, as after a welcome
        for (const id of announced.keys()) {
          if (before.has(id)) continue;
          const values = latest.get(id);
          if (values) sendState(id, values);
          const why = downs.get(id);
          if (why) send({ t: "down", device: id, why });
        }
      }
      o.onStatus?.(status());
    },
    reconcile() {
      if (!joined()) return;
      const m = manifest();
      const same =
        JSON.stringify(m.devices) === JSON.stringify([...announced.values()]) &&
        JSON.stringify(m.unavailable) === JSON.stringify(unavailable);
      if (!same) kit.announce();
    },
    withdraw(id, why) {
      const def = defs.get(id);
      if (!def) return;
      for (const r of running.values()) if (r.device === id) r.ac.abort();
      def.stop?.();
      withdrawn.set(id, { kind: def.kind, why: `${def.kind}: ${why}`.slice(0, 300) });
      latest.delete(id);
      downs.delete(id);
      rate.delete(id);
      kit.announce();
    },
    down(id, why) {
      downs.set(id, why);
      if (joined() && announced.has(id)) send({ t: "down", device: id, why });
      o.onStatus?.(status());
    },
    up(id) {
      downs.delete(id);
      if (joined() && announced.has(id)) send({ t: "up", device: id });
      o.onStatus?.(status());
    },
    pause(why) {
      if (state === "lending") {
        held = why ? { why } : {};
        stopAll();
        send({ t: "paused", ...(why ? { why } : {}) });
        return to("paused");
      }
      // away: the pause is said once the page is welcomed again
      if (away && !held) {
        held = why ? { why } : {};
        o.onStatus?.(status());
      }
    },
    resume() {
      if (state === "paused") {
        held = null;
        send({ t: "resumed" });
        return to("lending");
      }
      if (away && held) {
        held = null;
        o.onStatus?.(status());
      }
    },
    reconnectNow() {
      if (state !== "reconnecting" || trying) return;
      if (retry) clearTimeout(retry);
      void attempt();
    },
    stopAll,
    status,
    close() {
      closing = true;
      if (ws) return ws.close(1000, "the person closed the page");
      if (state === "reconnecting") end(1000, "the person closed the page");
    },
  };
  return kit;
}
