// One Durable Object per robot_id. It owns the robot's state machines (CONTRACT §1): link, activity, control,
// call, episode, provider. Durable facts live in DO storage; only in-flight resolvers live in memory.
// It holds the runtime socket (/ws/robot) and the organ sockets (/ws/organ) as hibernatable WebSockets.
// The instance named LIBRARY has no robot: it only gives the program-library mutations an idempotency cache.

import { DurableObject } from "cloudflare:workers";
import {
  ACTIVITY_TRANSITIONS,
  CALL_TERMINAL,
  CALL_TRANSITIONS,
  CONTROL_TRANSITIONS,
  EPISODE_TRANSITIONS,
  LINK_TRANSITIONS,
  PROGRAM_TRANSITIONS,
  PROVIDER_TRANSITIONS,
} from "../../protocol/types.ts";
import type {
  BackendKind,
  CallState,
  Control,
  DeviceSpec,
  EpisodeState,
  ErrorCode,
  ImagePayload,
  OrganToRelay,
  ProviderState,
  RelayToOrgan,
  RelayToRuntime,
  RobotActivity,
  RobotLink,
  RobotProfile,
  RobotStateView,
  RobotTool,
  RuntimeToRelay,
} from "../../protocol/types.ts";
import { type Caller, type Config, type SocketRole, loadConfig, ownersOf, socketRefusal } from "./config.ts";
import { type Out, TOOL, ToolFail, assertTransition, errOut, okOut, toolError } from "./envelope.ts";
import { log } from "./log.ts";
import { checkDevices, checkProfile, resolveDevice } from "./manifest.ts";
import { firstViolation } from "../../protocol/schema.ts";
import { profileHash } from "../../protocol/validate.ts";
import { checkProgram } from "./program.ts";
import * as store from "./store.ts";

export const LIBRARY = "_library";
export const CLOSE = { HEARTBEAT: 4000, REFUSED: 4001, REPLACED: 4002, BAD_FRAME: 4003 } as const;
/** CONTRACT §7: a frame older than this is stale. */
const MAX_IMAGE_AGE_MS = 1500;
const IDEMPOTENCY_MS = 10 * 60 * 1000;
const RATE = { max: 5, windowMs: 1000 };
const STALLS_TO_FAULT = 3;
const ORGAN_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const READ_TOOLS: ReadonlySet<string> = new Set([
  "describe_robot",
  "describe_device",
  "read_device",
  "read_all",
  "sample_device",
  "wait_until",
]);
const DRIVETRAIN_TOOLS: ReadonlySet<string> = new Set(["drive", "turn", "arc"]);

export interface InvokeReq {
  robot_id: string; // LIBRARY for the program-library mutations
  caller: Caller;
  /** the caller is one of the principals this robot is assigned to by name */
  owner: boolean;
  tool: string;
  args: Record<string, unknown>;
  trace_id: string;
  /** set when the worker already rejected the call (bad arguments): the robot only records it */
  pre?: { code: ErrorCode; message: string };
}
export interface RobotStatus extends RobotStateView {
  battery_low: boolean | null;
  profile_hash: string | null;
  fault_reason: string | null;
  devices: number;
  organs: { organ_id: string; state: ProviderState; devices: number }[];
}

interface Persisted {
  robot_id: string;
  backend: BackendKind | null; // null until the first hello
  profile: RobotProfile | null;
  profile_hash: string | null;
  /** the runtime's honest upper bound for a verified stop, announced in hello */
  stop_worst_ms: number | null;
  devices: DeviceSpec[];
  activity: RobotActivity;
  control: Control;
  episode: { id: string | null; state: EpisodeState };
  fault_reason: string | null;
  stalls: number;
  battery_low: boolean | null; // null before the first connection
  organs: Record<string, { state: ProviderState; devices: DeviceSpec[] }>;
}
interface Attachment {
  role: "robot" | "organ";
  ready: boolean; // hello accepted
  since: number;
  organ_id?: string;
}
type RuntimeResult = Extract<RuntimeToRelay, { t: "result" }>;
type Reply =
  | { kind: "result"; m: RuntimeResult }
  | { kind: "timeout"; waited_ms: number }
  | { kind: "offline" }
  | { kind: "preempted"; m?: RuntimeResult };
interface PendingCall {
  lane: "read" | "act";
  preempted: boolean;
  finish: (r: Reply) => void;
}
interface Call {
  id: string;
  tool: string;
  state: CallState;
  dispatched: boolean;
  moving: boolean;
}
interface StopResult {
  motors_stopped: boolean;
  activity: RobotActivity;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const terminal = (s: CallState) => CALL_TERMINAL.includes(s);

/** Canonical form of a call (keys sorted), to tell a retry from a reused request_id. */
function signature(tool: string, args: unknown, principal: string): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : isObj(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon(v[k])]),
          )
        : v;
  return `${principal}:${tool}:${JSON.stringify(canon(args))}`;
}

/**
 * Image channels arrive as `Reading.image` inside the data (or as the result's own `image`). The pixels leave
 * the JSON and travel as the one image block; the reading keeps {mime, age_ms}. One image per result: a second
 * frame is dropped and says so.
 */
function liftImage(data: unknown, top?: ImagePayload): { data: unknown; image?: ImagePayload } {
  let image = top;
  const strip = (r: unknown): unknown => {
    if (!isObj(r) || !isObj(r.image) || typeof r.image.b64 !== "string") return r;
    const { b64, ...meta } = r.image as unknown as ImagePayload;
    if (!image) {
      image = { ...meta, b64 };
      return { ...r, image: meta };
    }
    return { ...r, image: { ...meta, omitted: "one image per result; read this channel on its own" } };
  };
  if (Array.isArray(data)) data = data.map(strip);
  else if (isObj(data) && Array.isArray(data.readings)) data = { ...data, readings: data.readings.map(strip) };
  return { data, ...(image ? { image } : {}) };
}

export class RobotDO extends DurableObject<Env> {
  private s: Persisted = {
    robot_id: "",
    backend: null,
    profile: null,
    profile_hash: null,
    stop_worst_ms: null,
    devices: [],
    activity: "idle",
    control: "owner",
    episode: { id: null, state: "none" },
    fault_reason: null,
    stalls: 0,
    battery_low: null,
    organs: {},
  };
  private link: RobotLink = "offline";
  private lastSeen = new Map<WebSocket, number>();
  private dropped = new WeakSet<WebSocket>();
  private pending = new Map<string, PendingCall>();
  private inflight = new Map<string, { sig: string; promise: Promise<Out> }>();
  private actTail: Promise<unknown> = Promise.resolve();
  /** bumped by every stop: queued calls and trial loops from an older generation are preempted */
  private stopGen = 0;
  private stopping: Promise<StopResult> | null = null;
  private stopAck: ((verified: boolean) => void) | null = null;
  private stopId: string | null = null;
  /** the call that put the robot in acting/running_program; only it may bring the robot back to idle */
  private actingCall: string | null = null;
  private recentMutations: number[] = [];
  private ticks = 0;
  /** last measured round trip to the runtime (heartbeat echo); 0 until one is measured */
  private rttMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<Persisted>("state");
      if (stored) this.s = stored;
      // rehydrate what memory held: the link from the live sockets, the organ registry from theirs
      const robots = ctx.getWebSockets("robot");
      if (robots.some((w) => this.att(w)?.ready)) this.link = "online";
      else if (robots.length > 0) this.link = "handshaking";
      const live = new Set(ctx.getWebSockets("organ").map((w) => this.att(w)?.organ_id));
      for (const id of Object.keys(this.s.organs)) if (!live.has(id)) delete this.s.organs[id];
      // a fresh instance has no in-flight call: an activity that says otherwise cannot be trusted
      if (this.s.activity === "acting" || this.s.activity === "running_program" || this.s.activity === "stopping")
        this.toFault(`the relay restarted while the robot was ${this.s.activity}; motors are unverified`);
    });
  }

  // ---------------------------------------------------------------- small helpers
  private get cfg(): Config {
    return loadConfig(this.env);
  }
  private save(): void {
    void this.ctx.storage.put("state", this.s);
  }
  private ensure(robot_id: string): void {
    if (this.s.robot_id === robot_id) return;
    if (this.s.robot_id !== "") throw new Error(`durable object of ${this.s.robot_id} was addressed as ${robot_id}`);
    this.s.robot_id = robot_id;
    this.save();
  }
  private att(ws: WebSocket): Attachment | null {
    return ws.deserializeAttachment() as Attachment | null;
  }
  private send(ws: WebSocket | undefined, m: RelayToRuntime | RelayToOrgan): boolean {
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }
  private robotSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets("robot").find((w) => !this.dropped.has(w) && this.att(w)?.ready);
  }
  private organSocket(organ_id: string): WebSocket | undefined {
    return this.ctx
      .getWebSockets("organ")
      .find((w) => !this.dropped.has(w) && this.att(w)?.ready && this.att(w)?.organ_id === organ_id);
  }
  private view(): RobotStateView {
    // backend is null until the runtime's first hello
    return {
      id: this.s.robot_id,
      backend: this.s.backend,
      link: this.link,
      activity: this.s.activity,
      control: this.s.control,
      episode: this.s.episode.state,
    };
  }

  // ---------------------------------------------------------------- FSM writers (every transition is asserted)
  private setLink(to: RobotLink): void {
    if (this.link === to) return;
    assertTransition("link", LINK_TRANSITIONS, this.link, to);
    log("link", { robot_id: this.s.robot_id, from: this.link, to });
    this.link = to;
  }
  private setActivity(to: RobotActivity): void {
    if (this.s.activity === to) return;
    assertTransition("activity", ACTIVITY_TRANSITIONS, this.s.activity, to);
    log("activity", { robot_id: this.s.robot_id, from: this.s.activity, to });
    this.s.activity = to;
    this.save();
  }
  private toFault(reason: string): void {
    this.s.fault_reason = reason;
    if (this.s.activity !== "fault") {
      assertTransition("activity", ACTIVITY_TRANSITIONS, this.s.activity, "fault");
      log("activity", { robot_id: this.s.robot_id, from: this.s.activity, to: "fault", reason });
      this.s.activity = "fault";
    }
    this.save();
  }
  private organTo(organ_id: string, to: ProviderState): void {
    const o = this.s.organs[organ_id];
    if (!o || o.state === to) return;
    assertTransition(`organ ${organ_id}`, PROVIDER_TRANSITIONS, o.state, to);
    log("organ", { robot_id: this.s.robot_id, organ_id, from: o.state, to });
    o.state = to;
  }
  private step(call: Call, to: CallState): void {
    if (!CALL_TRANSITIONS[call.state].includes(to))
      throw new Error(`call FSM: illegal ${call.state} → ${to} (${call.tool})`);
    call.state = to;
    if (to === "dispatched") call.dispatched = true;
  }

  // ---------------------------------------------------------------- sockets
  override async fetch(request: Request): Promise<Response> {
    const role = request.headers.get("x-relay-role");
    const robot_id = request.headers.get("x-robot-id") ?? "";
    if ((role !== "robot" && role !== "organ") || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("websocket only", { status: 426 });
    this.ensure(robot_id);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, ready: false, since: Date.now() } satisfies Attachment);
    this.lastSeen.set(server, Date.now());
    if (role === "robot" && this.link === "offline") this.setLink("handshaking");
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + this.cfg.timing.hbIntervalMs);
  }

  private refuse(ws: WebSocket, code: number, reason: string): void {
    const a = this.att(ws);
    log("ws_refused", { robot_id: this.s.robot_id, role: a?.role, ok: false, reason });
    try {
      ws.close(code, reason.slice(0, 120));
    } catch {}
    this.gone(ws, reason);
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = this.att(ws);
    if (!a || this.dropped.has(ws)) return;
    this.lastSeen.set(ws, Date.now());
    let m: unknown;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.refuse(ws, CLOSE.BAD_FRAME, "frame is not JSON");
    }
    if (!isObj(m) || typeof m.t !== "string") return this.refuse(ws, CLOSE.BAD_FRAME, "frame has no type `t`");
    try {
      if (!a.ready) {
        if (m.t !== "hello") return this.refuse(ws, CLOSE.REFUSED, "first frame must be hello");
        return a.role === "robot" ? await this.robotHello(ws, a, m as never) : await this.organHello(ws, a, m as never);
      }
      if (a.role === "robot") this.robotMessage(ws, m as unknown as RuntimeToRelay);
      else this.organMessage(ws, a, m as unknown as OrganToRelay);
    } catch (e) {
      log("ws_error", {
        robot_id: this.s.robot_id,
        role: a.role,
        t: m.t,
        message: e instanceof Error ? e.message : String(e),
      });
      this.refuse(ws, CLOSE.BAD_FRAME, e instanceof Error ? e.message : "bad frame");
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
    this.gone(ws, `socket closed (${code}${reason ? ` ${reason}` : ""})`);
  }
  override async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws, "socket error");
  }

  /** The one place a socket leaves. Idempotent. */
  private gone(ws: WebSocket, why: string): void {
    if (this.dropped.has(ws)) return;
    this.dropped.add(ws);
    this.lastSeen.delete(ws);
    const a = this.att(ws);
    if (!a) return;
    if (a.role === "organ") {
      if (a.ready && a.organ_id && this.s.organs[a.organ_id] && !this.organSocket(a.organ_id))
        this.dropOrgan(a.organ_id);
      return;
    }
    if (a.ready) this.linkLost(why);
    else if (this.link === "handshaking" && !this.ctx.getWebSockets("robot").some((w) => !this.dropped.has(w)))
      this.setLink("offline");
  }

  /** online → offline: every in-flight call fails with robot_offline; a robot that was moving is now unverified. */
  private linkLost(why: string): void {
    if (this.link !== "online") return;
    this.setLink("offline");
    for (const p of [...this.pending.values()]) p.finish({ kind: "offline" });
    this.stopAck?.(false);
    if (this.s.activity === "acting" || this.s.activity === "running_program") {
      this.actingCall = null;
      this.toFault(`the link was lost while the robot was ${this.s.activity} (${why}); motors are unverified`);
    }
    this.save();
  }

  // ---------------------------------------------------------------- runtime socket
  /** Null when the token is a credential of `role` bound to this robot, else the refusal (CONTRACT §8). */
  private async refusal(token: unknown, role: SocketRole): Promise<string | null> {
    const p = typeof token === "string" ? await this.cfg.identify(token) : null;
    return socketRefusal(p, role, this.s.robot_id);
  }

  private async robotHello(ws: WebSocket, a: Attachment, m: Extract<RuntimeToRelay, { t: "hello" }>): Promise<void> {
    if (m.v !== 2) return this.refuse(ws, CLOSE.REFUSED, "hello.v must be 2");
    if (m.robot_id !== this.s.robot_id)
      return this.refuse(ws, CLOSE.REFUSED, `hello.robot_id does not match this socket's robot (${this.s.robot_id})`);
    const denied = await this.refusal(m.token, "runtime");
    if (denied) return this.refuse(ws, CLOSE.REFUSED, denied);
    if (m.backend !== "ev3" && m.backend !== "sim" && m.backend !== "organ")
      return this.refuse(ws, CLOSE.REFUSED, "hello.backend must be ev3, sim or organ");
    const bad = checkProfile(m.profile) ?? checkDevices(m.devices);
    if (bad) return this.refuse(ws, CLOSE.REFUSED, `manifest rejected: ${bad}`);
    if (m.profile_hash !== profileHash(m.profile))
      return this.refuse(ws, CLOSE.REFUSED, "hello.profile_hash must equal profileHash(profile) from the contract");
    if (typeof m.stop_worst_ms !== "number" || !Number.isFinite(m.stop_worst_ms) || m.stop_worst_ms <= 0)
      return this.refuse(ws, CLOSE.REFUSED, "hello.stop_worst_ms must be a positive number of ms");

    // a new hello for the same robot replaces the old socket
    for (const old of this.ctx.getWebSockets("robot"))
      if (old !== ws && this.att(old)?.ready && !this.dropped.has(old)) {
        try {
          old.close(CLOSE.REPLACED, "replaced by a new hello");
        } catch {}
        this.gone(old, "replaced by a new hello");
      }
    this.setLink("handshaking");
    ws.serializeAttachment({ ...a, ready: true } satisfies Attachment);
    this.setLink("online");
    this.s.backend = m.backend;
    this.s.profile = m.profile;
    this.s.profile_hash = m.profile_hash;
    this.s.stop_worst_ms = m.stop_worst_ms;
    this.s.devices = m.devices;
    this.s.stalls = 0;
    this.s.battery_low = false;
    this.save();
    this.send(ws, { t: "welcome", session_id: crypto.randomUUID() });
    this.pushOrgans();
    this.ctx.waitUntil(this.recordRobot());
  }

  private async recordRobot(): Promise<void> {
    if (!this.s.backend) return;
    try {
      await store.upsertRobot(this.env.DB, {
        id: this.s.robot_id,
        owner_principal: ownersOf(this.cfg, this.s.robot_id).join(",") || null,
        backend: this.s.backend,
        profile: this.s.profile,
        devices: this.s.devices,
      });
    } catch (e) {
      log("robots_write_error", { robot_id: this.s.robot_id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private robotMessage(ws: WebSocket, m: RuntimeToRelay): void {
    switch (m.t) {
      case "hb":
        if (isObj(m.echo) && Number.isFinite(m.echo.ts) && Number.isFinite(m.echo.held_ms))
          // a number the runtime supplies: kept inside [0, heartbeat timeout] so it cannot stretch deadlines unbounded
          this.rttMs = Math.min(
            this.cfg.timing.hbTimeoutMs,
            Math.max(0, Date.now() - m.echo.ts - Math.max(0, m.echo.held_ms)),
          );
        this.s.battery_low = m.battery_low === true;
        // fault triggers (CONTRACT §1): a battery device reporting low, or a runtime-reported error
        this.onRuntimeFault(
          m.battery_low === true ? (m.fault ?? "battery low: a battery device reports low") : m.fault,
        );
        return;
      case "result": {
        const p = this.pending.get(m.call_id);
        if (!p) return log("late_result", { robot_id: this.s.robot_id, call_id: m.call_id });
        return p.finish(p.preempted ? { kind: "preempted", m } : { kind: "result", m });
      }
      case "stopped":
        // reply to {t:"stop"}: drives stopping → idle | fault. One that arrives with no stop pending is late.
        if (this.stopAck && m.stop_id === this.stopId) return this.stopAck(m.motors_stopped === true);
        return log("late_stopped", { robot_id: this.s.robot_id, stop_id: m.stop_id, motors_stopped: m.motors_stopped });
      case "devices": {
        const bad = checkDevices(m.devices);
        if (bad) return this.refuse(ws, CLOSE.BAD_FRAME, `manifest rejected: ${bad}`);
        this.s.devices = m.devices;
        this.save();
        this.ctx.waitUntil(this.recordRobot());
        return;
      }
      case "organ_req":
        return this.organRequest(ws, m);
      case "hello":
        return this.refuse(ws, CLOSE.BAD_FRAME, "hello was already accepted on this socket");
      default:
        return this.refuse(ws, CLOSE.BAD_FRAME, `unknown frame type ${String((m as { t: unknown }).t)}`);
    }
  }

  /** A heartbeat carrying `fault` is a runtime-reported fault. While stopping, the {t:"stopped"} reply decides. */
  private onRuntimeFault(fault: string | undefined): void {
    if (fault !== undefined && this.s.activity !== "fault" && this.s.activity !== "stopping")
      this.toFault(`the runtime reported: ${fault}`);
  }

  // ---------------------------------------------------------------- organs
  private async organHello(ws: WebSocket, a: Attachment, m: Extract<OrganToRelay, { t: "hello" }>): Promise<void> {
    if (m.v !== 2) return this.refuse(ws, CLOSE.REFUSED, "hello.v must be 2");
    if (m.robot_id !== this.s.robot_id)
      return this.refuse(ws, CLOSE.REFUSED, `hello.robot_id does not match this socket's robot (${this.s.robot_id})`);
    const denied = await this.refusal(m.token, "organ");
    if (denied) return this.refuse(ws, CLOSE.REFUSED, denied);
    if (typeof m.organ_id !== "string" || !ORGAN_ID.test(m.organ_id) || m.organ_id === "ev3" || m.organ_id === "sim")
      return this.refuse(ws, CLOSE.REFUSED, `organ_id must match ${ORGAN_ID} and not be a built-in provider name`);
    const bad = checkDevices(m.devices, m.organ_id);
    if (bad) return this.refuse(ws, CLOSE.REFUSED, `manifest rejected: ${bad}`);

    const old = this.organSocket(m.organ_id);
    if (old) {
      try {
        old.close(CLOSE.REPLACED, "replaced by a new hello");
      } catch {}
      this.dropped.add(old);
      this.lastSeen.delete(old);
    }
    if (this.s.organs[m.organ_id]) this.dropOrgan(m.organ_id);
    ws.serializeAttachment({ ...a, ready: true, organ_id: m.organ_id } satisfies Attachment);
    this.s.organs[m.organ_id] = { state: "announced", devices: m.devices };
    log("organ", { robot_id: this.s.robot_id, organ_id: m.organ_id, to: "announced", devices: m.devices.length });
    this.save();
    this.send(ws, { t: "welcome", session_id: crypto.randomUUID() });
    this.pushOrgans();
  }

  private dropOrgan(organ_id: string): void {
    this.organTo(organ_id, "gone");
    this.pushOrgans(); // tells the runtime it is gone, once
    delete this.s.organs[organ_id];
    this.save();
  }

  private organMessage(ws: WebSocket, a: Attachment, m: OrganToRelay): void {
    const id = a.organ_id as string;
    const o = this.s.organs[id];
    if (!o) return;
    switch (m.t) {
      case "hb":
        if (o.state !== "active") {
          this.organTo(id, "active");
          this.save();
          this.pushOrgans();
        }
        return;
      case "devices": {
        const bad = checkDevices(m.devices, id);
        if (bad) return this.refuse(ws, CLOSE.BAD_FRAME, `manifest rejected: ${bad}`);
        o.devices = m.devices;
        this.save();
        return this.pushOrgans();
      }
      case "res": {
        // stateless pass-through, in memory only: the runtime matches req_id and owns the timeout
        const out: RelayToRuntime = m.ok
          ? { t: "organ_res", req_id: m.req_id, ok: true, data: m.data, ...(m.image ? { image: m.image } : {}) }
          : { t: "organ_res", req_id: m.req_id, ok: false, error: m.error };
        this.send(this.robotSocket(), out);
        return;
      }
      case "hello":
        return this.refuse(ws, CLOSE.BAD_FRAME, "hello was already accepted on this socket");
      default:
        return this.refuse(ws, CLOSE.BAD_FRAME, `unknown frame type ${String((m as { t: unknown }).t)}`);
    }
  }

  private organRequest(ws: WebSocket, m: Extract<RuntimeToRelay, { t: "organ_req" }>): void {
    const o = this.s.organs[m.organ_id];
    const fail = (code: ErrorCode, message: string) =>
      void this.send(ws, { t: "organ_res", req_id: m.req_id, ok: false, error: { code, message } });
    if (!o || o.state === "gone")
      return fail(
        "unknown_device",
        `no attached provider "${m.organ_id}"; attached: ${Object.keys(this.s.organs).join(", ") || "none"}`,
      );
    if (o.state === "stale")
      return fail("provider_stale", `"${m.organ_id}" has not been heard from in ${this.cfg.timing.hbTimeoutMs} ms`);
    const { t: _t, organ_id: _o, ...req } = m;
    if (!this.send(this.organSocket(m.organ_id), { t: "req", ...req }))
      fail("provider_stale", `"${m.organ_id}" is not reachable`);
  }

  private pushOrgans(): void {
    const organs = Object.entries(this.s.organs).map(([organ_id, o]) => ({
      organ_id,
      state: o.state,
      devices: o.state === "gone" ? [] : o.devices,
    }));
    this.send(this.robotSocket(), { t: "organs", organs });
  }

  // ---------------------------------------------------------------- the 1 s tick: heartbeats and every time-based transition of the sockets
  override async alarm(): Promise<void> {
    const t = this.cfg.timing;
    const now = Date.now();
    let alive = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.dropped.has(ws)) continue;
      const a = this.att(ws);
      if (!a) continue;
      // after a wake-up from hibernation nothing is known about the socket: start counting now
      const seen = this.lastSeen.get(ws) ?? (this.lastSeen.set(ws, now), now);
      if (!a.ready) {
        if (now - a.since > t.helloTimeoutMs) this.refuse(ws, CLOSE.REFUSED, `no hello within ${t.helloTimeoutMs} ms`);
        else alive++;
        continue;
      }
      const silent = now - seen;
      if (a.role === "robot") {
        if (silent > t.hbTimeoutMs) {
          this.refuse(ws, CLOSE.HEARTBEAT, `no heartbeat for ${silent} ms`);
          continue;
        }
      } else if (a.organ_id) {
        const o = this.s.organs[a.organ_id];
        if (o?.state === "stale" && silent > t.organGoneMs) {
          this.refuse(ws, CLOSE.HEARTBEAT, `no heartbeat for ${silent} ms`);
          continue;
        }
        if (o?.state === "active" && silent > t.hbTimeoutMs) {
          this.organTo(a.organ_id, "stale");
          this.save();
          this.pushOrgans();
        }
      }
      this.send(ws, { t: "hb", ts: now });
      alive++;
    }
    if (++this.ticks % 60 === 0) await this.purgeIdempotency(now);
    if (alive > 0) await this.ctx.storage.setAlarm(now + t.hbIntervalMs);
  }

  private async purgeIdempotency(now: number): Promise<void> {
    const all = await this.ctx.storage.list<{ exp: number }>({ prefix: "idem:" });
    const dead = [...all].filter(([, v]) => v.exp <= now).map(([k]) => k);
    if (dead.length) await this.ctx.storage.delete(dead);
  }

  // ---------------------------------------------------------------- RPC: status
  async status(robot_id: string): Promise<RobotStatus> {
    this.ensure(robot_id);
    return {
      ...this.view(),
      battery_low: this.s.battery_low,
      profile_hash: this.s.profile_hash,
      fault_reason: this.s.fault_reason,
      devices: this.s.devices.length,
      organs: Object.entries(this.s.organs).map(([organ_id, o]) => ({
        organ_id,
        state: o.state,
        devices: o.devices.length,
      })),
    };
  }

  // ---------------------------------------------------------------- RPC: one tool call (Call FSM)
  async invoke(r: InvokeReq): Promise<Out> {
    const t0 = Date.now();
    const library = r.robot_id === LIBRARY;
    this.ensure(r.robot_id);
    const def = TOOL.get(r.tool);
    if (!def) throw new Error(`invoke: unknown tool ${r.tool}`);
    const call: Call = { id: crypto.randomUUID(), tool: r.tool, state: "received", dispatched: false, moving: false };
    const episode_id = this.s.episode.state === "running" ? this.s.episode.id : null;
    const request_id = typeof r.args.request_id === "string" ? r.args.request_id : null;
    const view = () => (library ? undefined : this.view());

    const finish = async (out: Out): Promise<Out> => {
      const code = out.envelope.ok ? null : out.envelope.error.code;
      const ms = Date.now() - t0;
      log("call", {
        robot_id: library ? null : r.robot_id,
        tool: r.tool,
        call_state: call.state,
        code,
        ms,
        trace_id: r.trace_id,
        principal: r.caller.id,
        request_id,
        ok: out.envelope.ok,
      });
      try {
        await store.insertCall(this.env.DB, {
          id: call.id,
          robot_id: library ? null : r.robot_id,
          tool: r.tool,
          request_id,
          state: call.state,
          code,
          ms,
          episode_id,
          created_at: t0,
          principal: r.caller.id,
          moving: call.moving,
          trace_id: r.trace_id,
        });
      } catch (e) {
        log("calls_write_error", {
          robot_id: r.robot_id,
          trace_id: r.trace_id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      return out;
    };

    if (r.pre) {
      this.step(call, "rejected");
      return finish(errOut(r.tool, toolError(r.pre.code, r.pre.message), view()));
    }

    const run = async (): Promise<Out> => {
      try {
        const res = await this.execute(r, call);
        if (!terminal(call.state)) this.step(call, "completed");
        return okOut(r.tool, res.data, view(), res.image);
      } catch (e) {
        const fail = e instanceof ToolFail ? e : new ToolFail("internal", `unexpected error (trace_id ${r.trace_id})`);
        if (!(e instanceof ToolFail))
          log("internal_error", {
            robot_id: r.robot_id,
            tool: r.tool,
            trace_id: r.trace_id,
            message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
          });
        if (call.state === "received") this.step(call, "rejected");
        else if (!terminal(call.state)) this.step(call, "failed");
        return errOut(r.tool, fail.toError(), view());
      }
    };

    if (!def.mutating || request_id === null) return finish(await run());

    // idempotency by (robot_id, request_id): a retry joins the call in flight or returns the stored result.
    // The same request_id with another tool or other arguments is a different action: refused, never replayed.
    const key = library ? `idem:${r.caller.id}:${request_id}` : `idem:${request_id}`;
    const sig = signature(r.tool, r.args, r.caller.id);
    const joined = this.inflight.get(key);
    const stored = joined ? undefined : await this.ctx.storage.get<{ out: Out; exp: number; sig: string }>(key);
    const hit = joined ?? (stored && stored.exp > t0 ? stored : undefined);
    if (hit) {
      if (hit.sig !== sig) {
        this.step(call, "rejected");
        return finish(
          errOut(
            r.tool,
            toolError(
              "invalid_argument",
              `request_id: "${request_id}" was already used for a different action (another tool, other arguments or another principal); use a new request_id for a new action`,
            ),
            view(),
          ),
        );
      }
      const out = joined ? await joined.promise : (stored as { out: Out }).out;
      this.step(call, "deduplicated");
      return finish({ envelope: out.envelope });
    }
    if (!library) {
      this.recentMutations = this.recentMutations.filter((t) => t > t0 - RATE.windowMs);
      if (this.recentMutations.length >= RATE.max) {
        this.step(call, "rejected");
        const wait = Math.max(1, (this.recentMutations[0] as number) + RATE.windowMs - t0);
        return finish(
          errOut(
            r.tool,
            toolError(
              "rate_limited",
              `more than ${RATE.max} mutating calls per second on ${r.robot_id}; retry in ${wait} ms`,
              wait,
            ),
            view(),
          ),
        );
      }
      this.recentMutations.push(t0);
    }
    const p = run();
    this.inflight.set(key, { sig, promise: p });
    try {
      const out = await p;
      // stored only when the call got as far as acting: a call rejected up front (busy, offline) may be retried
      // with the same request_id. The image is never stored.
      if (call.dispatched)
        await this.ctx.storage.put(key, { out: { envelope: out.envelope }, exp: Date.now() + IDEMPOTENCY_MS, sig });
      return await finish(out);
    } finally {
      this.inflight.delete(key);
    }
  }

  private async execute(r: InvokeReq, call: Call): Promise<{ data: unknown; image?: ImagePayload }> {
    switch (r.tool) {
      case "stop": {
        this.requireOnline();
        this.step(call, "dispatched"); // relay-owned or read: no queue
        const res = await this.stop("stop tool");
        if (!res.motors_stopped)
          throw new ToolFail(
            "stop_unverified",
            `the runtime did not confirm that every motor stopped within ${this.stopWindowMs()} ms; the robot is now in fault. Inspect it (read_all), then reset_fault.`,
          );
        return { data: res };
      }
      case "take_control":
      case "release_control":
        return { data: await this.changeControl(r, call) };
      case "start_episode":
      case "mark_episode":
      case "end_episode":
        return { data: await this.episodeTool(r, call) };
      case "save_program":
      case "retire_program":
        return { data: await this.libraryTool(r, call) };
      case "verify_program":
        return { data: await this.verifyProgram(r, call) };
      default:
        return this.robotTool(r, call);
    }
  }

  // ---------------------------------------------------------------- preconditions
  private requireOnline(): WebSocket {
    const ws = this.link === "online" ? this.robotSocket() : undefined;
    if (!ws)
      throw new ToolFail(
        "robot_offline",
        `robot ${this.s.robot_id} is ${this.link}: its runtime is not connected. Nothing was sent; a disconnected runtime stops its own motors after 3 s without the relay.`,
      );
    return ws;
  }
  private requireControl(r: InvokeReq): void {
    const c = this.s.control;
    if (r.caller.role === "user") {
      if (c !== "owner")
        throw new ToolFail(
          "not_in_control",
          `an admin holds control of ${this.s.robot_id}; reading still works, acting waits until the admin releases control`,
        );
    } else if (c !== "admin" && !r.owner) {
      throw new ToolFail("not_in_control", `control of ${this.s.robot_id} is with its owner; call take_control first`);
    }
  }
  /** Moving tools need idle. */
  private requireIdle(): void {
    const a = this.s.activity;
    if (a === "fault")
      throw new ToolFail(
        "fault",
        `robot is in fault: ${this.s.fault_reason ?? "unknown reason"}. Only stop and reset_fault act in fault.`,
      );
    if (a !== "idle") throw new ToolFail("busy", `robot is ${a}; wait for it to finish or call stop`, 500);
  }
  private allDevices(): DeviceSpec[] {
    const ids = new Set(this.s.devices.map((d) => d.id));
    const extra = Object.values(this.s.organs)
      .filter((o) => o.state !== "gone")
      .flatMap((o) => o.devices)
      .filter((d) => !ids.has(d.id));
    return [...this.s.devices, ...extra];
  }
  private limits() {
    const l = this.s.profile?.limits;
    if (!l) throw new ToolFail("robot_offline", `robot ${this.s.robot_id} has not announced a profile yet`);
    return l;
  }

  // ---------------------------------------------------------------- dispatch to the runtime
  /**
   * What a deadline adds to a tool's own budget: the round trip (at least DEADLINE_MARGIN_MS, or twice the measured
   * one) plus the runtime's announced worst-case stop. With it the runtime's own limit (max_command_ms,
   * max_program_ms, timeout_ms, duration_ms) always ends the call first and answers with data.
   */
  private graceMs(): number {
    return Math.max(this.cfg.timing.deadlineMarginMs, 2 * this.rttMs) + (this.s.stop_worst_ms ?? 0);
  }

  /**
   * Sends one {t:"call"} and waits for its result, the relay-side deadline, the link dropping, or a stop.
   * Two backstops behind the tool's own budget: the runtime aborts the call at budget + grace and reports what it
   * did; the relay gives up one more grace later, when not even that report arrived.
   */
  private dispatch(
    call_id: string,
    tool: RobotTool,
    args: Record<string, unknown>,
    budgetMs: number,
    lane: "read" | "act",
  ): Promise<Reply> {
    const ws = this.link === "online" ? this.robotSocket() : undefined;
    if (!ws) return Promise.resolve({ kind: "offline" });
    const grace = this.graceMs();
    const waitMs = Math.round(budgetMs + 2 * grace);
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.send(this.robotSocket(), { t: "abort", call_id });
        finish({ kind: "timeout", waited_ms: waitMs });
      }, waitMs);
      const finish = (reply: Reply) => {
        if (this.pending.get(call_id) !== p) return;
        this.pending.delete(call_id);
        clearTimeout(timer);
        resolve(reply);
      };
      const p: PendingCall = { lane, preempted: false, finish };
      this.pending.set(call_id, p);
      // deadline_ms is a duration (the two clocks are not synchronized)
      if (
        !this.send(ws, {
          t: "call",
          call_id,
          tool,
          args,
          deadline_ms: Math.max(1, Math.round(budgetMs + grace)),
          activity: this.s.activity,
        })
      )
        finish({ kind: "offline" });
    });
  }

  /** Serial lane for everything that acts. A queued job is dropped when a stop arrives or its deadline passes. */
  private enqueue<T>(call: Call, waitBudgetMs: number, job: () => Promise<T>): Promise<T> {
    const gen = this.stopGen;
    const deadline = Date.now() + waitBudgetMs;
    this.step(call, "queued");
    log("queued", { robot_id: this.s.robot_id, tool: call.tool, call_id: call.id });
    const run = this.actTail.then(async () => {
      if (gen !== this.stopGen) {
        this.step(call, "preempted");
        throw new ToolFail(
          "busy",
          "a stop arrived while this call waited in the queue; it was dropped and the robot did not act on it",
          500,
        );
      }
      if (this.link !== "online") {
        this.step(call, "failed");
        throw new ToolFail(
          "robot_offline",
          `robot ${this.s.robot_id} went offline while this call waited in the queue; it was not sent`,
        );
      }
      if (Date.now() > deadline) {
        this.step(call, "timed_out");
        throw new ToolFail("timeout", "the call's deadline passed while it waited in the queue; it was not sent");
      }
      this.step(call, "dispatched");
      return job();
    });
    this.actTail = run.catch(() => {});
    return run;
  }

  /** Turns a runtime reply into data or a typed failure, and sets the call's terminal state. */
  private async settle(call: Call, reply: Reply, tool: string): Promise<{ data: unknown; image?: ImagePayload }> {
    const fromRuntime = (m: RuntimeResult) => {
      // a move that timed out may have partly happened: never retryable, live or replayed from the idempotency cache
      if (!m.ok)
        throw new ToolFail(
          m.error.code,
          m.error.message,
          undefined,
          m.error.code === "timeout" && call.moving ? false : m.error.retryable,
        );
      const { data, image } = liftImage(m.data, m.image);
      if (image && image.age_ms > MAX_IMAGE_AGE_MS)
        throw new ToolFail(
          "stale_image",
          `the frame is ${Math.round(image.age_ms)} ms old (limit ${MAX_IMAGE_AGE_MS} ms); read again`,
        );
      return { data, ...(image ? { image } : {}) };
    };
    switch (reply.kind) {
      case "result":
        this.step(call, reply.m.ok ? "completed" : "failed");
        return fromRuntime(reply.m);
      case "offline":
        this.step(call, "failed");
        throw new ToolFail(
          "robot_offline",
          `robot ${this.s.robot_id} went offline before ${tool} answered; what it did is unknown`,
        );
      case "timeout":
        this.step(call, "timed_out");
        // a move that outlived its deadline is stopped, not left running
        if (call.moving) await this.stop(`${tool} timed out`).catch(() => {});
        throw new ToolFail(
          "timeout",
          `${tool} did not answer within ${reply.waited_ms} ms; it was aborted${call.moving ? " and the robot was stopped. It may have moved: read the robot (read_all) before moving again" : ""}`,
          undefined,
          call.moving ? false : undefined,
        );
      case "preempted":
        this.step(call, "preempted");
        if (reply.m) return fromRuntime(reply.m);
        throw new ToolFail(
          "timeout",
          `${tool} was preempted by stop and the runtime did not report what it had done within ${this.stopWindowMs()} ms; read the robot to see where it is`,
          undefined,
          call.moving ? false : undefined,
        );
    }
  }

  /** After a moving call: back to idle, unless a stop or a fault took the activity over. Counts consecutive stalls. */
  private release(call: Call, data?: unknown): void {
    if (this.actingCall !== call.id) return;
    this.actingCall = null;
    if (this.s.activity !== "acting" && this.s.activity !== "running_program") return;
    if (isObj(data) && typeof data.reason === "string")
      this.s.stalls = data.reason === "stalled" ? this.s.stalls + 1 : 0;
    if (this.s.stalls >= STALLS_TO_FAULT) {
      this.s.stalls = 0;
      this.toFault(`${STALLS_TO_FAULT} consecutive commands ended stalled`);
    } else this.setActivity("idle");
  }

  private budgetFor(tool: string, args: Record<string, unknown>, moving: boolean): number {
    const t = this.cfg.timing;
    if (tool === "run_program") return this.limits().max_program_ms;
    if (moving) return this.limits().max_command_ms;
    if (tool === "wait_until" && typeof args.timeout_ms === "number") return args.timeout_ms;
    if (tool === "sample_device" && typeof args.duration_ms === "number") return args.duration_ms;
    return t.callTimeoutMs;
  }

  /** Every RobotTool: the relay checks state, then the runtime does the work. */
  private async robotTool(r: InvokeReq, call: Call): Promise<{ data: unknown; image?: ImagePayload }> {
    const tool = r.tool as RobotTool;
    const { robot_id: _r, request_id: _q, ...args } = r.args;
    this.requireOnline();

    if (READ_TOOLS.has(tool)) {
      // read tools work in every online state and never wait behind an action
      const budget = this.budgetFor(tool, args, false);
      this.step(call, "dispatched"); // relay-owned or read: no queue
      return this.settle(call, await this.dispatch(call.id, tool, args, budget, "read"), tool);
    }

    this.requireControl(r);
    let sent: Record<string, unknown> = args;
    let program: store.StoredProgram | undefined;
    if (tool === "reset_fault") {
      if (this.s.activity !== "fault")
        throw new ToolFail("illegal_state", `reset_fault is only valid in fault; activity is ${this.s.activity}`);
    } else if (tool === "command_device") {
      const devices = this.allDevices();
      const device = resolveDevice(String(args.device), devices, this.s.profile);
      if (!device)
        throw new ToolFail(
          "unknown_device",
          `no device or role "${String(args.device)}" on ${this.s.robot_id}; devices: ${devices.map((d) => d.id).join(", ") || "none"}; roles: ${Object.keys(this.s.profile?.roles ?? {}).join(", ") || "none"}`,
        );
      const command = device.commands.find((c) => c.name === args.command);
      if (!command)
        throw new ToolFail(
          "unknown_command",
          `${device.id} has no command "${String(args.command)}"; commands: ${device.commands.map((c) => c.name).join(", ") || "none (read-only device)"}`,
        );
      // shape only (required, types, enums, unknown fields): sizes are the runtime's to clamp or chunk, then check
      const bad = firstViolation(command.params, args.args ?? {}, "args", "shape");
      if (bad)
        throw new ToolFail(
          "invalid_argument",
          `${bad} (params of ${device.id} ${command.name}; describe_device shows the schema)`,
        );
      call.moving = command.moves;
      if (call.moving) this.requireIdle();
      else if (this.s.activity === "fault") this.requireIdle();
    } else {
      if (tool === "run_program") {
        program = await store.getProgram(this.env.DB, String(args.name), args.version as number | undefined);
        if (program.state === "retired")
          throw new ToolFail("program_not_runnable", `${program.name} v${program.version} is retired`);
        if (this.s.backend !== "sim") {
          if (program.state !== "verified" && program.state !== "approved")
            throw new ToolFail(
              "program_not_runnable",
              `${program.name} v${program.version} is ${program.state}; on hardware only verified or approved programs run. Verify it on the twin first (verify_program).`,
            );
          // a verified program transfers only to a robot with the profile it was verified on (drivetrain, roles, limits)
          const on = program.verified_on;
          if (program.state === "verified" && on?.profile_hash !== this.s.profile_hash)
            throw new ToolFail(
              "program_not_runnable",
              `${program.name} v${program.version} was verified on ${on?.twin_id ?? "an unknown twin"} with profile_hash ${on?.profile_hash ?? "none"}, but ${this.s.robot_id} has profile_hash ${this.s.profile_hash}; verify it on a twin built from this robot's profile, or have an admin approve it.`,
            );
        }
        sent = {
          name: program.name,
          version: program.version,
          body: program.body,
          ...(program.success !== undefined ? { success: program.success } : {}),
        };
      } else if (!DRIVETRAIN_TOOLS.has(tool)) throw new Error(`robotTool: ${tool} is not a robot tool`);
      call.moving = true;
      this.requireIdle();
    }

    const budget = this.budgetFor(tool, args, call.moving);
    if (call.moving) {
      this.setActivity(tool === "run_program" ? "running_program" : "acting");
      this.actingCall = call.id;
    }
    let data: unknown;
    try {
      const res = await this.enqueue(call, budget + this.graceMs(), async () =>
        this.settle(call, await this.dispatch(call.id, tool, sent, budget, "act"), tool),
      );
      data = res.data;
      if (tool === "reset_fault" && this.s.activity === "fault") {
        this.s.fault_reason = null;
        this.s.stalls = 0;
        this.setActivity("idle");
      }
      if (program) {
        const outcome = isObj(data) && typeof data.outcome === "string" ? data.outcome : "unknown";
        await store.insertRun(this.env.DB, {
          name: program.name,
          version: program.version,
          robot_id: this.s.robot_id,
          backend: this.s.backend ?? "unknown",
          outcome,
          ms: isObj(data) && typeof data.ms === "number" ? data.ms : 0,
        });
      }
      return res;
    } finally {
      this.release(call, data);
    }
  }

  // ---------------------------------------------------------------- stop (never queued)
  /**
   * Preempts everything: {t:"stop"} and an {t:"abort"} per acting call go out now, queued calls are dropped.
   * stopping → idle when the runtime answers {t:"stopped"} with this stop_id inside the window (back to fault if it came from fault), else fault.
   * A second stop while one is pending joins it.
   */
  private stop(why: string): Promise<StopResult> {
    if (this.stopping) {
      log("stop_joined", { robot_id: this.s.robot_id, why });
      return this.stopping;
    }
    const ws = this.requireOnline();
    const cameFromFault = this.s.activity === "fault";
    this.setActivity("stopping");
    this.stopGen++;
    this.actingCall = null;
    log("stop", { robot_id: this.s.robot_id, why });
    const stop_id = crypto.randomUUID();
    this.stopId = stop_id;
    this.send(ws, { t: "stop", stop_id });
    const verifyMs = this.stopWindowMs();
    for (const [call_id, p] of this.pending) {
      if (p.lane !== "act") continue;
      this.send(ws, { t: "abort", call_id });
      p.preempted = true;
      setTimeout(() => p.finish({ kind: "preempted" }), verifyMs);
    }
    for (const organ of this.ctx.getWebSockets("organ"))
      if (this.att(organ)?.ready && !this.dropped.has(organ)) this.send(organ, { t: "stop" });

    this.stopping = (async (): Promise<StopResult> => {
      const verified = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), verifyMs);
        this.stopAck = (v) => {
          clearTimeout(timer);
          resolve(v);
        };
      });
      this.stopAck = null;
      if (this.s.activity === "stopping") {
        if (!verified) this.toFault(`stop (${why}) was not verified within ${verifyMs} ms`);
        else if (cameFromFault) this.setActivity("fault");
        else this.setActivity("idle");
      }
      return { motors_stopped: verified, activity: this.s.activity };
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** CONTRACT §1: a stop is unverified after the runtime's announced stop_worst_ms + the margin (500 ms). */
  private stopWindowMs(): number {
    if (this.s.stop_worst_ms === null)
      throw new ToolFail("robot_offline", `robot ${this.s.robot_id} has not announced stop_worst_ms yet`);
    return this.s.stop_worst_ms + this.cfg.timing.stopVerifyMarginMs;
  }

  // ---------------------------------------------------------------- control
  private async changeControl(r: InvokeReq, call: Call): Promise<unknown> {
    if (r.caller.role !== "admin") throw new ToolFail("unauthorized", `${r.tool} is for admins`);
    const to: Control = r.tool === "take_control" ? "admin" : "owner";
    assertTransition(
      "control",
      CONTROL_TRANSITIONS,
      this.s.control,
      to,
      `Control is already with the ${this.s.control}.`,
    );
    this.step(call, "dispatched"); // relay-owned or read: no queue
    // both transitions stop the robot first; an offline robot has nothing to stop
    let stopped: StopResult | { motors_stopped: null; note: string } = {
      motors_stopped: null,
      note: `robot is ${this.link}; nothing to stop`,
    };
    if (this.link === "online") stopped = await this.stop(r.tool);
    this.s.control = to;
    this.save();
    log("control", { robot_id: this.s.robot_id, to, principal: r.caller.id });
    return { control: to, stop: stopped };
  }

  // ---------------------------------------------------------------- episodes
  private async episodeTool(r: InvokeReq, call: Call): Promise<unknown> {
    const ep = this.s.episode;
    const db = this.env.DB;
    const now = Date.now();
    if (r.tool === "start_episode") {
      assertTransition(
        "episode",
        EPISODE_TRANSITIONS,
        ep.state,
        "running",
        ep.state === "running" ? "End the running episode first (end_episode)." : "",
      );
      this.step(call, "dispatched"); // relay-owned or read: no queue
      const id = crypto.randomUUID();
      await store.insertEpisode(db, {
        id,
        robot_id: this.s.robot_id,
        label: String(r.args.label),
        tags: (r.args.tags as string[] | undefined) ?? [],
        started_at: now,
      });
      this.s.episode = { id, state: "running" };
      this.save();
      return { id, label: r.args.label, state: "running", started_at: now };
    }
    if (ep.state !== "running" || !ep.id)
      throw new ToolFail(
        "illegal_state",
        `${r.tool} needs a running episode; episode state is ${ep.state}. Call start_episode first.`,
      );
    this.step(call, "dispatched"); // relay-owned or read: no queue
    if (r.tool === "mark_episode") {
      await store.insertMark(db, {
        episode_id: ep.id,
        kind: String(r.args.kind),
        note: typeof r.args.note === "string" ? r.args.note : "",
        at: now,
      });
      return store.episodeSummary(db, ep.id);
    }
    assertTransition("episode", EPISODE_TRANSITIONS, ep.state, "ended");
    await store.endEpisode(
      db,
      ep.id,
      String(r.args.outcome),
      r.args.metrics as Record<string, number> | undefined,
      now,
    );
    this.s.episode = { id: ep.id, state: "ended" };
    this.save();
    return store.episodeSummary(db, ep.id);
  }

  // ---------------------------------------------------------------- program library (runs in the LIBRARY instance)
  private async libraryTool(r: InvokeReq, call: Call): Promise<unknown> {
    const db = this.env.DB;
    if (r.tool === "save_program") {
      const checked = checkProgram(r.args.body, r.args.success);
      if (!checked.ok) throw new ToolFail("invalid_argument", checked.message);
      this.step(call, "dispatched"); // relay-owned or read: no queue
      return store.saveProgram(db, {
        name: String(r.args.name),
        author: r.caller.id,
        description: String(r.args.description),
        body: r.args.body,
        success: r.args.success,
        requires: checked.requires,
        pass_rate: typeof r.args.pass_rate === "number" ? r.args.pass_rate : 0.8,
      });
    }
    const p = await store.getProgram(db, String(r.args.name), r.args.version as number);
    if (p.author !== r.caller.id && r.caller.role !== "admin")
      throw new ToolFail(
        "unauthorized",
        `only its author (${p.author}) or an admin can retire ${p.name} v${p.version}`,
      );
    assertTransition(`program ${p.name} v${p.version}`, PROGRAM_TRANSITIONS, p.state, "retired");
    this.step(call, "dispatched"); // relay-owned or read: no queue
    return store.transitionProgram(db, p, "retired");
  }

  // ---------------------------------------------------------------- verify_program: trials on a twin
  private async verifyProgram(r: InvokeReq, call: Call): Promise<unknown> {
    this.requireOnline();
    this.requireControl(r);
    if (this.s.backend !== "sim")
      throw new ToolFail(
        "unsupported",
        `verify_program runs on a twin (backend sim); ${this.s.robot_id} is backend ${this.s.backend}. Use the robot's "-sim" twin.`,
      );
    const db = this.env.DB;
    const trials = r.args.trials as number;
    const program = await store.getProgram(db, String(r.args.name), r.args.version as number | undefined);
    assertTransition(
      `program ${program.name} v${program.version}`,
      PROGRAM_TRANSITIONS,
      program.state,
      "verified",
      "Only a draft can be verified; save a new version to verify again.",
    );

    // needs_review: the program touches something this twin does not have (matched by device id, role or kind)
    const devices = this.allDevices();
    const kinds = new Set(devices.map((d) => d.kind));
    const missing = program.requires.filter((ref) => !kinds.has(ref) && !resolveDevice(ref, devices, this.s.profile));
    if (missing.length > 0) {
      this.step(call, "dispatched"); // relay-owned or read: no queue
      const moved = await store.transitionProgram(db, program, "needs_review");
      return {
        success_rate: null,
        outcomes: [],
        state: moved.state,
        missing,
        note: `the twin has no ${missing.join(", ")}, so it cannot simulate this program; an admin must approve it before it runs on hardware`,
      };
    }

    call.moving = true;
    this.requireIdle();
    const limits = this.limits();
    this.setActivity("running_program");
    this.actingCall = call.id;
    const perTrial = limits.max_program_ms + this.cfg.timing.callTimeoutMs;
    const outcomes: { trial: number; outcome: string; reason: string; ms: number }[] = [];
    let ended: "done" | "preempted" | "offline" = "done";
    try {
      await this.enqueue(call, perTrial * trials, async () => {
        const gen = this.stopGen;
        for (let trial = 1; trial <= trials; trial++) {
          const t0 = Date.now();
          const interrupted = (reply: Reply): boolean => {
            if (reply.kind === "offline") ended = "offline";
            else if (reply.kind === "preempted" || gen !== this.stopGen) ended = "preempted";
            return ended !== "done";
          };
          if (gen !== this.stopGen) {
            ended = "preempted";
            break;
          }
          // CONTRACT §5: `sim.world reset` between trials
          const reset = await this.dispatch(
            `${call.id}:reset${trial}`,
            "command_device",
            { device: "sim.world", command: "reset", args: {} },
            this.cfg.timing.callTimeoutMs,
            "act",
          );
          if (interrupted(reset)) break;
          if (reset.kind !== "result" || !reset.m.ok) {
            const why =
              reset.kind === "result" && !reset.m.ok ? `${reset.m.error.code}: ${reset.m.error.message}` : "no answer";
            outcomes.push({ trial, outcome: "failed", reason: `sim.world reset failed (${why})`, ms: Date.now() - t0 });
            continue;
          }
          const run = await this.dispatch(
            `${call.id}:trial${trial}`,
            "run_program",
            {
              name: program.name,
              version: program.version,
              body: program.body,
              ...(program.success !== undefined ? { success: program.success } : {}),
            },
            limits.max_program_ms,
            "act",
          );
          if (interrupted(run)) break;
          let outcome = "failed";
          let reason = "no answer within the deadline";
          if (run.kind === "result") {
            if (!run.m.ok) reason = `${run.m.error.code}: ${run.m.error.message}`;
            else {
              const d = isObj(run.m.data) ? run.m.data : {};
              outcome = typeof d.outcome === "string" ? d.outcome : "failed";
              reason = typeof d.reason === "string" ? d.reason : outcome;
            }
          } else if (run.kind === "timeout") outcome = "timeout";
          const ms = Date.now() - t0;
          outcomes.push({ trial, outcome, reason, ms });
          await store.insertRun(db, {
            name: program.name,
            version: program.version,
            robot_id: this.s.robot_id,
            backend: "sim",
            outcome,
            ms,
          });
        }
      });
    } finally {
      this.release(call);
    }
    const how = ended as "done" | "preempted" | "offline"; // assigned inside the closure above
    if (how === "offline")
      throw new ToolFail(
        "robot_offline",
        `the twin went offline after ${outcomes.length} of ${trials} trials; the program stays ${program.state}`,
      );
    if (how === "preempted") {
      this.step(call, "preempted");
      return {
        success_rate: null,
        outcomes,
        state: program.state,
        note: `stopped after ${outcomes.length} of ${trials} trials; the program stays ${program.state}`,
      };
    }
    const success_rate = outcomes.filter((o) => o.outcome === "succeeded").length / trials;
    if (success_rate >= program.pass_rate) {
      if (!this.s.profile_hash) throw new ToolFail("internal", "the twin has no profile_hash");
      const verified_on = { twin_id: this.s.robot_id, profile_hash: this.s.profile_hash, at: Date.now() };
      const moved = await store.transitionProgram(db, program, "verified", success_rate, verified_on);
      return { success_rate, outcomes, state: moved.state, verified_on };
    }
    await store.setSuccessRate(db, program, success_rate);
    return {
      success_rate,
      outcomes,
      state: program.state,
      note: `success_rate ${success_rate} is below pass_rate ${program.pass_rate}; the program stays draft`,
    };
  }
}
