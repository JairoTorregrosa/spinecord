// The page hub (CONTRACT §2.4): one Provider per robot that holds the devices of every peripheral page lent to
// that robot. It outlives the robot's runtimes, so each runtime the robot builds gets the same hub as its last
// provider. A page reaches it through a PageSocket; listening, the token and the page state machine with its
// ping timers belong to apps/local, which tells each page's link what state the page is in.
//
// What the hub answers, by page state:
//   active      reads of pushed channels from the latest pushed value (null + a device_offline error when a ping
//               is silent for staleMs: a watch counts three of those and ends with condition_unreadable);
//               other reads and commands as requests to the page, each with a deadline
//   announced, asleep, or the device down   device_offline, thrown (retryable, retry_after_ms 2000)
// A page moves nothing: stop() asks every page to end its commands, waits at most stopWaitMs, and is verified.
import {
  RuntimeError,
  type CommandResult,
  type CommandSpec,
  type DeviceSpec,
  type ErrorCode,
  type PageDevice,
  type PageState,
  type PageToServer,
  type PageUnavailable,
  type Provider,
  type Reading,
  type Scalar,
  type ServerToPage,
  type Value,
} from "../protocol/types";
import { imageSize } from "./image";

/** The process's end of one page's socket. */
export interface PageSocket {
  send(msg: ServerToPage): void;
}

export const PAGE_LIMITS = {
  /** A page silent this long has pushed values that are no answer (CONTRACT §4). */
  stale_ms: 300,
  /** A ping that has waited less than this is on its way: a page is silent only while an older one waits. */
  answer_ms: 100,
  /** A read the page does not answer in this time answers device_offline. */
  read_ms: 2000,
  /** Added to a command's own bound: past it the command answers device_offline. */
  command_margin_ms: 2000,
  /** How long stop() waits for the pages' answers. */
  stop_wait_ms: 300,
  /** A read of pushed values keeps the page watched this long: apps/local pings it faster meanwhile. */
  watched_ms: 500,
  max_frame_bytes: 512 * 1024,
  max_frame_side_px: 1280,
  frames_per_s: 2,
  retry_after_ms: 2000,
  busy_retry_ms: 250,
} as const;

/** The times a hub holds; PAGE_LIMITS gives them, a test shortens them. */
export interface HubTimes {
  stale_ms: number;
  read_ms: number;
  command_margin_ms: number;
  stop_wait_ms: number;
}
export interface PageHubOptions {
  /** Milliseconds, monotonic enough for deadlines. Default Date.now. */
  now?: () => number;
  /** Overrides of PAGE_LIMITS' times (tests). */
  limits?: Partial<HubTimes>;
}

/** What the person at a page must do, by why its devices cannot answer. */
const remedy = (name: string, paused: boolean): string =>
  paused
    ? `Ask the person at the page named ${name} to resume lending, then send the call again.`
    : `Ask the person at the page named ${name} to bring it to the front, keep its screen on and keep it open, then send the call again.`;

function offline(message: string): RuntimeError {
  const e = new RuntimeError("device_offline", message, true);
  e.retry_after_ms = PAGE_LIMITS.retry_after_ms;
  e.next = ["describe_robot"];
  return e;
}
const busy = (message: string): RuntimeError => {
  const e = new RuntimeError("busy", message, true);
  e.retry_after_ms = PAGE_LIMITS.busy_retry_ms;
  return e;
};

// The codes a page may answer a request with; anything else is the page's bug and answers internal.
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

interface Pending {
  device: string;
  resolve: (msg: Extract<PageToServer, { t: "res" }>, image?: Uint8Array) => void;
  reject: (e: RuntimeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One page of the hub: what apps/local drives it with. */
export class PageLink {
  state: PageState = "announced";
  /** Why the page is not active (paused, silent, closed); null while active. */
  why: string | null = null;
  paused = false;
  devices: PageDevice[];
  unavailable: PageUnavailable[];
  private socket: PageSocket | null;
  private readonly down = new Map<string, string>(); // local device id → why it is down
  private readonly values = new Map<string, { value: Scalar; ts: number }>(); // "<device>.<channel>"
  private readonly pending = new Map<number, Pending>();
  private readonly busyDevices = new Set<string>();
  private readonly frames = new Map<string, number[]>(); // local device id → when its latest frames were asked
  private pings: { n: number; at: number }[] = [];
  private nextPing = 0;
  private nextId = 0;
  private awaitingBinary: { id: number; bytes: number } | null = null;
  /** When a read last asked for this page's pushed values (a watch polls them). */
  watchedAt = -Infinity;
  /** When the page last answered a ping. */
  seenAt: number;

  constructor(
    readonly name: string,
    socket: PageSocket,
    devices: PageDevice[],
    unavailable: PageUnavailable[],
    private readonly hub: PageHub,
  ) {
    this.socket = socket;
    this.devices = devices;
    this.unavailable = unavailable;
    this.seenAt = hub.now();
  }

  get open(): boolean {
    return this.socket !== null;
  }
  /** The page's devices as the runtime sees them: ids prefixed with the page name. */
  specs(): DeviceSpec[] {
    return this.devices.map((d) => ({ ...d, id: `${this.name}.${d.id}`, provider: this.name, roles: [...d.roles] }));
  }

  // ---------- liveness (apps/local's timers call these) ----------
  /** Sends one ping and remembers when; silence is counted from the oldest one not answered. */
  ping(): void {
    if (!this.socket) return;
    const n = ++this.nextPing;
    this.pings.push({ n, at: this.hub.now() });
    this.socket.send({ t: "ping", n });
  }
  /**
   * How long the page has been silent: 0 while no ping waits for its answer; else since its last answer, or since
   * PAGE_LIMITS.answer_ms before the oldest waiting ping was sent when that is later. In a watch (a ping every
   * 100 ms) that is the time since the last answer; the first ping after a quiet second has stale_ms - answer_ms for its answer.
   */
  silentMs(): number {
    const oldest = this.pings[0];
    if (!oldest) return 0;
    return Math.max(0, this.hub.now() - Math.max(this.seenAt, oldest.at - PAGE_LIMITS.answer_ms));
  }
  /** True while a read of pushed values came in the last PAGE_LIMITS.watched_ms. */
  watched(): boolean {
    return this.hub.now() - this.watchedAt < PAGE_LIMITS.watched_ms;
  }

  /** The state apps/local's page machine is in. Leaving `active` ends every request in flight. */
  setState(state: PageState, why: string | null): void {
    this.state = state;
    this.why = state === "active" ? null : why;
    if (state !== "active") this.failAll(this.offlineError(null));
  }

  /** The socket closed: requests in flight end, and nothing more is sent until a page joins under this name. */
  closed(): void {
    this.socket = null;
    this.pings = [];
    this.awaitingBinary = null;
    this.failAll(offline(`The page named ${this.name} closed its connection. ${remedy(this.name, false)}`));
  }

  /** A page joined again under this name: its new socket and manifest take this page's place. */
  replace(socket: PageSocket, devices: PageDevice[], unavailable: PageUnavailable[]): void {
    this.socket = socket;
    this.pings = [];
    this.seenAt = this.hub.now();
    this.down.clear();
    this.values.clear();
    this.frames.clear();
    this.busyDevices.clear();
    this.setDevices(devices, unavailable);
  }

  /** A manifest that passed validatePageManifest: the runtime scans again. */
  setDevices(devices: PageDevice[], unavailable: PageUnavailable[]): void {
    const ids = new Set(devices.map((d) => d.id));
    for (const [id, p] of this.pending)
      if (!ids.has(p.device)) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(offline(`The page named ${this.name} stopped lending ${this.name}.${p.device}.`));
      }
    // a cached value is kept only for a channel the new manifest still pushes, with the same type
    for (const key of [...this.values.keys()]) {
      const [device, channel] = key.split(".") as [string, string];
      const was = this.devices.find((d) => d.id === device)?.channels.find((c) => c.name === channel);
      const is = devices.find((d) => d.id === device)?.channels.find((c) => c.name === channel);
      if (!is || is.pushed !== true || is.type !== was?.type) this.values.delete(key);
    }
    for (const id of [...this.down.keys()]) if (!ids.has(id)) this.down.delete(id);
    this.devices = devices;
    this.unavailable = unavailable;
    this.hub.changed();
  }

  /**
   * One message from the page, already parsed and of a known `t`; null when it was taken, else why it breaks the
   * protocol (the caller closes the socket with 4000). hello, devices, ping, paused and resumed are apps/local's.
   */
  receive(msg: PageToServer): string | null {
    switch (msg.t) {
      case "pong": {
        if (typeof msg.n !== "number") return "pong.n must be a number";
        this.pings = this.pings.filter((p) => p.n > msg.n);
        this.seenAt = this.hub.now();
        return null;
      }
      case "res":
        return this.onRes(msg);
      case "state": {
        const d = this.devices.find((x) => x.id === msg.device);
        if (!d || typeof msg.values !== "object" || msg.values === null) return "state: unknown device";
        const ts = this.hub.now();
        for (const [channel, value] of Object.entries(msg.values)) {
          const c = d.channels.find((x) => x.name === channel);
          if (!c || c.pushed !== true) return `state: ${msg.device}.${channel} is not a pushed channel`;
          if (typeof value !== c.type || (typeof value === "number" && !Number.isFinite(value)))
            return `state: ${msg.device}.${channel} must be a ${c.type}`;
          this.values.set(`${msg.device}.${channel}`, { value, ts });
        }
        return null;
      }
      case "down": {
        if (!this.devices.some((x) => x.id === msg.device) || typeof msg.why !== "string")
          return "down: unknown device or no why";
        this.down.set(msg.device, msg.why.slice(0, 300));
        const e = this.offlineError(msg.device);
        for (const [id, p] of this.pending)
          if (p.device === msg.device) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            p.reject(e);
          }
        return null;
      }
      case "up":
        if (!this.devices.some((x) => x.id === msg.device)) return "up: unknown device";
        this.down.delete(msg.device);
        return null;
      default:
        return `the hub does not take a message of type ${String(msg.t)}`;
    }
  }

  /** One binary message: the bytes of the frame whose `res` came just before it. */
  binary(bytes: Uint8Array): string | null {
    const want = this.awaitingBinary;
    if (!want) return "a binary message that no image res announced";
    this.awaitingBinary = null;
    if (bytes.length !== want.bytes) return `the image has ${bytes.length} bytes, its res said ${want.bytes}`;
    const p = this.pending.get(want.id);
    if (!p) return null; // its request ended meanwhile (timeout, abort)
    this.pending.delete(want.id);
    clearTimeout(p.timer);
    p.resolve(this.held.get(want.id)!, bytes);
    this.held.delete(want.id);
    return null;
  }
  private readonly held = new Map<number, Extract<PageToServer, { t: "res" }>>();

  private onRes(msg: Extract<PageToServer, { t: "res" }>): string | null {
    if (typeof msg.id !== "number") return "res.id must be a number";
    if (msg.ok && msg.image) {
      const img = msg.image;
      if (
        typeof img !== "object" ||
        (img.mime !== "image/jpeg" && img.mime !== "image/png") ||
        !Number.isInteger(img.bytes) ||
        img.bytes < 1 ||
        !(typeof img.age_ms === "number" && img.age_ms >= 0)
      )
        return "res.image must be {channel, mime: image/jpeg | image/png, bytes, age_ms}";
      // the frame's bytes follow as the next message, whether or not the request still waits
      this.awaitingBinary = { id: msg.id, bytes: img.bytes };
      if (this.pending.has(msg.id)) this.held.set(msg.id, msg);
      return null;
    }
    const p = this.pending.get(msg.id);
    if (!p) return null; // a late answer to a request that already ended
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
    return null;
  }

  // ---------- requests ----------
  /** device_offline for this page, or for one device of it that is down. */
  private offlineError(device: string | null): RuntimeError {
    const downWhy = device === null ? undefined : this.down.get(device);
    if (downWhy !== undefined)
      return offline(
        `Device ${this.name}.${device} is down: ${downWhy}. The page's other devices work. ${remedy(this.name, false)}`,
      );
    const why = this.why ?? (this.state === "announced" ? "has not answered its first ping yet" : "is not answering");
    return offline(`The page named ${this.name} ${why}. ${remedy(this.name, this.paused)}`);
  }
  /** Throws device_offline unless this page and this device can answer now. */
  usable(device: string): void {
    if (this.state !== "active" || !this.socket) throw this.offlineError(null);
    if (this.down.has(device)) throw this.offlineError(device);
  }
  private failAll(e: RuntimeError): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.held.clear();
  }
  private request(
    device: string,
    msg: (id: number) => ServerToPage,
    deadlineMs: number,
    late: () => RuntimeError,
  ): { id: number; answer: Promise<{ res: Extract<PageToServer, { t: "res" }>; image?: Uint8Array }> } {
    const id = ++this.nextId;
    const answer = new Promise<{ res: Extract<PageToServer, { t: "res" }>; image?: Uint8Array }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.held.delete(id);
        reject(late());
      }, deadlineMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { device, resolve: (res, image) => resolve({ res, image }), reject, timer });
    });
    this.socket!.send(msg(id));
    return { id, answer };
  }
  /** Ends one request here, whatever the page answers later. */
  private forget(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.held.delete(id);
  }

  async read(device: PageDevice, channels: string[]): Promise<Reading[]> {
    const id = `${this.name}.${device.id}`;
    const pushed = channels.filter((c) => device.channels.find((x) => x.name === c)?.pushed === true);
    const asked = channels.filter((c) => !pushed.includes(c));
    const out: Reading[] = [];
    if (pushed.length) {
      this.watchedAt = this.hub.now();
      // a value is an answer only while the page answers its pings: a watch counts these as polls without a value
      const silent = this.silentMs();
      const stale =
        silent >= this.hub.limits.stale_ms
          ? `device_offline: the page named ${this.name} has not answered a ping for ${silent} ms. ${remedy(this.name, false)}`
          : null;
      for (const channel of pushed) {
        const v = this.values.get(`${device.id}.${channel}`);
        const unit = device.channels.find((x) => x.name === channel)?.unit;
        const base = { device: id, channel, ...(unit ? { unit } : {}) };
        if (stale) out.push({ ...base, value: null, ts: this.hub.now(), error: stale });
        else if (!v)
          out.push({ ...base, value: null, ts: this.hub.now(), error: "the page has not reported this channel yet" });
        else out.push({ ...base, value: v.value, ts: v.ts });
      }
    }
    if (asked.length) out.push(...(await this.ask(device, asked)));
    return channels.map((c) => out.find((r) => r.channel === c)!);
  }

  private async ask(device: PageDevice, channels: string[]): Promise<Reading[]> {
    const id = `${this.name}.${device.id}`;
    const image = channels.find((c) => device.channels.find((x) => x.name === c)?.type === "image");
    if (image) {
      const now = this.hub.now();
      const recent = (this.frames.get(device.id) ?? []).filter((t) => now - t < 1000);
      if (recent.length >= PAGE_LIMITS.frames_per_s)
        throw busy(
          `${id} gives at most ${PAGE_LIMITS.frames_per_s} frames per second; send the read again in a moment.`,
        );
      this.frames.set(device.id, [...recent, now]);
    }
    const ms = this.hub.limits.read_ms;
    const { answer } = this.request(
      device.id,
      (rid) => ({ t: "req", id: rid, op: "read", device: device.id, channels }),
      ms,
      () =>
        offline(
          `The page named ${this.name} did not answer a read of ${id} within ${ms} ms. ${remedy(this.name, false)}`,
        ),
    );
    const { res, image: bytes } = await answer;
    if (!res.ok) throw pageError(id, res.error);
    const ts = this.hub.now();
    const values = (res.readings ?? {}) as Record<string, unknown>;
    return channels.map((channel): Reading => {
      const unit = device.channels.find((x) => x.name === channel)?.unit;
      const base = { device: id, channel, ...(unit ? { unit } : {}) };
      if (channel === image) {
        if (!bytes || !res.image) return { ...base, value: null, ts, error: "the page returned no frame" };
        const size = imageSize(bytes, res.image.mime);
        if (!size) return { ...base, value: null, ts, error: `the page's frame is not a readable ${res.image.mime}` };
        if (
          bytes.length > PAGE_LIMITS.max_frame_bytes ||
          Math.max(size.width, size.height) > PAGE_LIMITS.max_frame_side_px
        )
          return { ...base, value: null, ts, error: "frame_too_large" };
        const age_ms = res.image.age_ms;
        return {
          ...base,
          value: null,
          ts: ts - age_ms,
          image: { mime: res.image.mime, b64: Buffer.from(bytes).toString("base64"), age_ms },
        };
      }
      const v = values[channel];
      if (v === undefined || v === null)
        return { ...base, value: null, ts, error: "the page returned no value for this channel" };
      if (!isValue(v)) return { ...base, value: null, ts, error: "the page returned a value of no known type" };
      return { ...base, value: v, ts };
    });
  }

  async command(
    device: PageDevice,
    cmd: CommandSpec,
    args: Record<string, Value>,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const id = `${this.name}.${device.id}`;
    if (this.busyDevices.has(device.id))
      throw busy(`${id} runs one command at a time and is running one; send this one when it has ended.`);
    const bound = cmd.bound.kind === "ms" ? cmd.bound.max : 0;
    const ms = bound + this.hub.limits.command_margin_ms;
    const t0 = this.hub.now();
    const preempted = (): CommandResult => ({
      requested: args,
      measured: {},
      clamped: false,
      reason: "preempted",
      ms: this.hub.now() - t0,
    });
    if (signal.aborted) return preempted();
    this.busyDevices.add(device.id);
    try {
      const { id: rid, answer } = this.request(
        device.id,
        (rid) => ({
          t: "req",
          id: rid,
          op: "command",
          device: device.id,
          command: cmd.name,
          args,
          deadline_ms: bound || this.hub.limits.read_ms,
        }),
        ms,
        () =>
          offline(
            `The page named ${this.name} did not answer ${id} ${cmd.name} within ${ms} ms.${cmd.name === "speak" ? " The phrase may have been cut." : ""} ${remedy(this.name, false)}`,
          ),
      );
      // an abort ends the command here at once; the page is told and its late answer is dropped
      const aborted = new Promise<"aborted">((resolve) => {
        signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      let got: Awaited<typeof answer> | "aborted";
      try {
        got = await Promise.race([answer, aborted]);
      } catch (e) {
        if (cmd.name === "speak" && e instanceof RuntimeError && e.code === "device_offline")
          e.message = `${e.message} The phrase may have been cut.`;
        throw e;
      }
      if (got === "aborted") {
        this.forget(rid);
        answer.catch(() => {});
        const aid = ++this.nextId;
        this.socket?.send({ t: "req", id: aid, op: "abort", of: rid });
        return preempted();
      }
      const { res } = got;
      if (!res.ok) throw pageError(`${id} ${cmd.name}`, res.error);
      const r = res.result;
      if (!r || typeof r !== "object" || typeof r.reason !== "string")
        throw new RuntimeError("internal", `the page answered ${id} ${cmd.name} without a result {measured, reason}`);
      return {
        requested: args,
        measured: (typeof r.measured === "object" && r.measured !== null ? r.measured : {}) as Record<string, Value>,
        clamped: r.clamped === true,
        reason: r.reason,
        ms: this.hub.now() - t0,
      };
    } finally {
      this.busyDevices.delete(device.id);
    }
  }

  /** Asks the page to end every command it runs; resolves when it answered or after stop_wait_ms. */
  async stop(): Promise<void> {
    if (!this.socket || this.state === "asleep" || this.state === "gone") return;
    const ms = this.hub.limits.stop_wait_ms;
    const { answer } = this.request(
      "",
      (id) => ({ t: "req", id, op: "stop" }),
      ms,
      () => offline(`The page named ${this.name} did not answer stop within ${ms} ms.`),
    );
    await answer.then(
      () => {},
      () => {},
    );
  }
}

const isValue = (v: unknown): v is Value =>
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (Array.isArray(v) &&
    (v.every((x) => typeof x === "number" && Number.isFinite(x)) || v.every((x) => typeof x === "string")));

function pageError(what: string, error: unknown): RuntimeError {
  const e = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  const message = `${what}: ${typeof e.message === "string" ? e.message.slice(0, 300) : "the page gave no message"}`;
  const code = PAGE_CODES.includes(e.code as ErrorCode) ? (e.code as ErrorCode) : "internal";
  if (code === "device_offline") return offline(message);
  if (code === "busy") return busy(message);
  return new RuntimeError(code, code === "internal" ? `the page failed: ${message}` : message, code === "timeout");
}

/** The Provider of every page of one robot. */
export class PageHub implements Provider {
  readonly id = "pages";
  readonly backend = "page" as const;
  readonly stop_worst_ms = 350;
  readonly now: () => number;
  readonly limits: HubTimes;
  private readonly pages = new Map<string, PageLink>();
  private readonly listeners = new Set<() => void>();

  constructor(o: PageHubOptions = {}) {
    this.now = o.now ?? Date.now;
    this.limits = { ...PAGE_LIMITS, ...o.limits };
  }

  /** The pages that hold devices (every page that is not gone). */
  links(): PageLink[] {
    return [...this.pages.values()];
  }
  link(name: string): PageLink | undefined {
    return this.pages.get(name);
  }
  /** A page joins with a manifest that passed validatePageManifest. Its devices are in the registry when the runtime has scanned again. */
  join(name: string, socket: PageSocket, devices: PageDevice[], unavailable: PageUnavailable[]): PageLink {
    const old = this.pages.get(name);
    if (old) {
      if (old.open) throw new Error(`a page named ${name} is already open`);
      old.replace(socket, devices, unavailable);
      return old;
    }
    const link = new PageLink(name, socket, devices, unavailable, this);
    this.pages.set(name, link);
    this.changed();
    return link;
  }
  /** The page is gone: its devices leave the registry. */
  remove(name: string): void {
    const link = this.pages.get(name);
    if (!link) return;
    if (link.open) link.closed();
    this.pages.delete(name);
    this.changed();
  }
  /** Tells every runtime that holds this hub to scan again. */
  changed(): void {
    for (const cb of this.listeners) cb();
  }

  // ---------- Provider ----------
  async devices(): Promise<DeviceSpec[]> {
    return this.links().flatMap((l) => l.specs());
  }
  private find(device: string): { link: PageLink; d: PageDevice } {
    const dot = device.indexOf(".");
    const link = this.pages.get(device.slice(0, dot));
    const d = link?.devices.find((x) => x.id === device.slice(dot + 1));
    if (!link || !d) throw new RuntimeError("unknown_device", `No page device "${device}": its page left.`);
    return { link, d };
  }
  async read(device: string, channels?: string[]): Promise<Reading[]> {
    const { link, d } = this.find(device);
    link.usable(d.id);
    const names = channels ?? d.channels.filter((c) => c.type !== "image").map((c) => c.name);
    return link.read(d, names);
  }
  async command(
    device: string,
    command: string,
    args: Record<string, Value>,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const { link, d } = this.find(device);
    const cmd = d.commands.find((c) => c.name === command);
    if (!cmd) throw new RuntimeError("unknown_command", `${device} has no command "${command}"`);
    link.usable(d.id);
    return link.command(d, cmd, args, signal);
  }
  async stop(): Promise<{ motors_stopped: boolean }> {
    await Promise.all(this.links().map((l) => l.stop()));
    // a page has no motor: there is nothing to verify, whatever a page answered
    return { motors_stopped: true };
  }
  onDevicesChanged(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
}
