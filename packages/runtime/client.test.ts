import { describe, expect, test } from "bun:test";
import type { DeviceSpec, RelayToRuntime, RobotProfile, RuntimeToRelay } from "../protocol/types";
import { profileHash } from "../protocol/validate";
import { createRuntimeClient, type ClientState, type WebSocketLike } from "./client";
import { FakeClock } from "./clock";
import { MockProvider } from "./mock";
import { createRuntime } from "./runtime";

class FakeSocket implements WebSocketLike {
  static last: FakeSocket;
  static count = 0;
  sent: RuntimeToRelay[] = [];
  closed: { code?: number; reason?: string } | undefined;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    FakeSocket.count++;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.onclose?.({ code, reason });
  }
  relay(m: RelayToRuntime) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  of<T extends RuntimeToRelay["t"]>(t: T) {
    return this.sent.filter((m): m is Extract<RuntimeToRelay, { t: T }> => m.t === t);
  }
}

const GAS: DeviceSpec = {
  id: "mcu1.gas",
  provider: "mcu1",
  kind: "gas",
  roles: [],
  description: "Gas sensor.",
  commands: [
    {
      name: "fan",
      description: "Runs the fan.",
      moves: true,
      bound: { kind: "ms", params: ["ms"], max: 5000 },
      params: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
    },
    {
      name: "heat",
      description: "Heats the element.",
      moves: false,
      bound: { kind: "ms", params: ["ms"], max: 5000 },
      params: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
    },
  ],
  channels: [
    { name: "ppm", type: "number", unit: "ppm", description: "Concentration." },
    { name: "frame", type: "image", description: "Picture." },
  ],
};

async function setup(o: { reconnect_ms?: number; battery?: boolean } = {}) {
  const clock = new FakeClock();
  const mock = new MockProvider({
    clock,
    extra: o.battery
      ? [
          {
            id: "mock.battery",
            provider: "mock",
            kind: "battery",
            roles: [],
            description: "Battery.",
            commands: [],
            channels: [
              { name: "voltage_v", type: "number", unit: "v", description: "Voltage." },
              { name: "low", type: "boolean", description: "Under the driver threshold." },
            ],
          },
        ]
      : [],
  });
  mock.values.set("mock.battery.voltage_v", 7.4);
  mock.values.set("mock.battery.low", false);
  const profile: RobotProfile = {
    id: "r1",
    roles: {},
    notes: [],
    limits: { max_speed_pct: 80, max_command_ms: 10000, max_drive_cm: 100, max_turn_deg: 360, max_program_ms: 20000 },
    drivetrain: {
      type: "differential",
      pair_device: "mock.pair",
      wheel_diameter_cm: 5.6,
      axle_track_cm: 12,
      forward_sign: 1,
    },
  };
  const runtime = createRuntime({ profile, providers: [mock], clock });
  const states: ClientState[] = [];
  const events: string[] = [];
  const client = createRuntimeClient({
    runtime,
    url: "wss://relay.example/ws/robot",
    token: "secret",
    WebSocket: FakeSocket,
    clock,
    reconnect_ms: o.reconnect_ms,
    onState: (s) => states.push(s),
    onEvent: (e) => events.push(e.kind),
  });
  client.connect();
  const ws = FakeSocket.last;
  ws.onopen?.({});
  await clock.sleep(0);
  const online = async () => {
    ws.relay({ t: "welcome", session_id: "s1" });
    await clock.sleep(0);
  };
  // keeps the relay side alive: one heartbeat per second for `ms`
  const alive = async (ms: number) => {
    for (let t = 0; t < ms; t += 500) {
      ws.relay({ t: "hb", ts: clock.now() });
      await clock.sleep(500);
    }
  };
  return { clock, mock, runtime, client, ws, states, events, online, alive };
}

describe("RuntimeClient", () => {
  test("hello carries the profile and local devices; welcome → online", async () => {
    const s = await setup();
    expect(s.ws.url).toBe("wss://relay.example/ws/robot?robot_id=r1");
    const hello = s.ws.of("hello")[0]!;
    expect(hello.profile_hash).toBe(profileHash(hello.profile));
    expect(hello.stop_worst_ms).toBe(850); // slowest of: local provider 100 + 50, organ stop timeout 800 + 50
    for (const d of hello.devices) for (const c of d.commands) expect(c.bound.max).toBeGreaterThanOrEqual(0);
    expect(s.ws.sent[0]).toMatchObject({
      t: "hello",
      v: 2,
      robot_id: "r1",
      token: "secret",
      backend: "sim",
      profile: { id: "r1" },
    });
    expect(s.ws.of("hello")[0]!.devices.map((d) => d.id)).toContain("mock.gas");
    expect(s.client.state()).toBe("handshaking");
    await s.online();
    expect(s.states).toEqual(["connecting", "handshaking", "online"]);
    s.client.close();
    expect(s.client.state()).toBe("closed");
  });
  test("call → result, with image; errors keep their contract code", async () => {
    const s = await setup();
    await s.online();
    s.ws.relay({
      t: "call",
      call_id: "c1",
      tool: "read_device",
      args: { robot_id: "r1", device: "mock.gas" },
      deadline_ms: 5000,
      activity: "idle",
    });
    s.ws.relay({
      t: "call",
      call_id: "c2",
      tool: "read_device",
      args: { device: "mock.camera", channels: ["frame"] },
      deadline_ms: 5000,
      activity: "idle",
    });
    s.ws.relay({
      t: "call",
      call_id: "c3",
      tool: "read_device",
      args: { device: "ghost" },
      deadline_ms: 5000,
      activity: "idle",
    });
    await s.clock.sleep(0);
    const [r1, r2, r3] = ["c1", "c2", "c3"].map((id) => s.ws.of("result").find((r) => r.call_id === id)!);
    expect(r1).toMatchObject({ ok: true, data: [{ device: "mock.gas", channel: "ppm", value: 412 }] });
    expect(r2).toMatchObject({ ok: true, image: { mime: "image/jpeg", b64: "/9j/AAAA" } });
    expect(r3).toMatchObject({ ok: false, error: { code: "unknown_device", retryable: false } });
    expect((r3 as any).error.message).toContain("mock.pair");
    s.client.close();
  });
  test("abort preempts a running call; its result still arrives", async () => {
    const s = await setup();
    await s.online();
    s.ws.relay({
      t: "call",
      call_id: "c1",
      tool: "drive",
      args: { distance_cm: 80, request_id: "q" },
      deadline_ms: 20000,
      activity: "idle",
    });
    await s.alive(1000);
    s.ws.relay({ t: "abort", call_id: "c1" });
    await s.clock.sleep(0);
    expect(s.ws.of("result")[0]).toMatchObject({ call_id: "c1", ok: true, data: { reason: "preempted" } });
    s.client.close();
  });
  test("a call past its deadline is aborted and answered with timeout", async () => {
    const s = await setup();
    await s.online();
    s.ws.relay({
      t: "call",
      call_id: "c1",
      tool: "drive",
      args: { distance_cm: 80 },
      deadline_ms: 600,
      activity: "idle",
    });
    await s.alive(1000);
    expect(s.ws.of("result")[0]).toMatchObject({
      call_id: "c1",
      ok: false,
      error: { code: "timeout", retryable: true },
    });
    const n = s.mock.log.length;
    await s.alive(1000);
    expect(s.mock.log.length).toBe(n);
    s.client.close();
  });
  test("stop from the relay stops the providers and aborts calls; an unverified stop is reported", async () => {
    const s = await setup();
    await s.online();
    s.ws.relay({
      t: "call",
      call_id: "c1",
      tool: "drive",
      args: { distance_cm: 80 },
      deadline_ms: 20000,
      activity: "idle",
    });
    await s.alive(500);
    s.ws.relay({ t: "stop", stop_id: "k1" });
    await s.clock.sleep(0);
    expect(s.mock.stops).toBe(1);
    expect(s.ws.of("result")[0]).toMatchObject({ ok: true, data: { reason: "preempted" } });
    expect(s.ws.of("stopped")).toEqual([{ t: "stopped", stop_id: "k1", motors_stopped: true }]);
    s.mock.stopVerified = false;
    s.ws.relay({ t: "stop", stop_id: "k2" });
    await s.clock.sleep(0);
    expect(s.ws.of("stopped")[1]).toEqual({ t: "stopped", stop_id: "k2", motors_stopped: false });
    s.client.close();
  });
  test("heartbeat every second; battery_low follows any device of kind battery", async () => {
    const s = await setup({ battery: true });
    await s.online();
    await s.alive(3000);
    const hb = s.ws.of("hb");
    expect(hb.length).toBe(3);
    expect(hb[1]!.ts - hb[0]!.ts).toBe(1000);
    expect(hb.at(-1)!.battery_low).toBe(false);
    expect(s.mock.stops).toBe(0);
    s.mock.values.set("mock.battery.low", true);
    await s.alive(2000);
    expect(s.ws.of("hb").at(-1)!.battery_low).toBe(true);
    const none = await setup();
    await none.online();
    await none.alive(2000);
    expect("battery_low" in none.ws.of("hb").at(-1)!).toBe(false);
    none.client.close();
    s.client.close();
  });
  test("3 s without a relay heartbeat stops the motors once and drops the socket", async () => {
    const s = await setup();
    await s.online();
    await s.alive(2000);
    s.ws.relay({
      t: "call",
      call_id: "c1",
      tool: "drive",
      args: { distance_cm: 90 },
      deadline_ms: 20000,
      activity: "idle",
    });
    await s.clock.sleep(2600);
    expect(s.mock.stops).toBe(0);
    await s.clock.sleep(1000);
    expect(s.mock.stops).toBe(1);
    expect(s.events).toContain("heartbeat_lost");
    expect(s.ws.closed).toMatchObject({ code: 4000 });
    expect(s.client.state()).toBe("closed");
    const n = s.mock.log.length;
    await s.clock.sleep(5000);
    expect(s.mock.log.length).toBe(n);
    expect(s.mock.stops).toBe(1);
  });
  test("a hung provider read never delays the watchdog", async () => {
    const s = await setup({ battery: true });
    await s.online();
    s.mock.read = () => new Promise(() => {}); // the brick stops answering reads
    await s.alive(1000);
    const sent = s.ws.of("hb").length;
    await s.clock.sleep(4000);
    expect(s.ws.of("hb").length).toBeGreaterThan(sent);
    expect(s.mock.stops).toBe(1);
    expect(s.events).toContain("heartbeat_lost");
  });
  test("socket close stops the robot and reconnects when asked to", async () => {
    const s = await setup({ reconnect_ms: 500 });
    await s.online();
    const before = FakeSocket.count;
    s.ws.close(1006, "network");
    await s.clock.sleep(0);
    expect(s.mock.stops).toBe(1);
    expect(s.client.state()).toBe("closed");
    await s.clock.sleep(600);
    expect(FakeSocket.count).toBe(before + 1);
    expect(s.client.state()).toBe("connecting");
    FakeSocket.last.onopen?.({});
    await s.clock.sleep(0);
    expect(FakeSocket.last.sent[0]).toMatchObject({ t: "hello" });
    s.client.close();
    await s.clock.sleep(2000);
    expect(FakeSocket.count).toBe(before + 1);
  });
  test("organs: devices appear, reads and commands are proxied through organ_req / organ_res", async () => {
    const s = await setup();
    await s.online();
    s.ws.relay({ t: "organs", organs: [{ organ_id: "mcu1", state: "active", devices: [GAS] }] });
    await s.clock.sleep(0);
    expect(s.runtime.devices().map((d) => d.id)).toContain("mcu1.gas");
    expect(s.runtime.localDevices().map((d) => d.id)).not.toContain("mcu1.gas");

    s.ws.relay({
      t: "call",
      call_id: "c1",
      tool: "read_device",
      args: { device: "mcu1.gas", channels: ["ppm"] },
      deadline_ms: 5000,
      activity: "idle",
    });
    await s.clock.sleep(0);
    const q1 = s.ws.of("organ_req")[0]!;
    expect(q1).toMatchObject({ organ_id: "mcu1", op: "read", device: "mcu1.gas", channels: ["ppm"] });
    expect("allow_mode_switch" in q1).toBe(false);
    s.ws.relay({
      t: "organ_res",
      req_id: q1.req_id,
      ok: true,
      data: [{ device: "mcu1.gas", channel: "ppm", value: 77, ts: s.clock.now() }],
    });
    await s.clock.sleep(0);
    expect(s.ws.of("result")[0]).toMatchObject({ call_id: "c1", ok: true, data: [{ value: 77, unit: "ppm" }] });

    s.ws.relay({
      t: "call",
      call_id: "c2",
      tool: "read_device",
      args: { device: "mcu1.gas", channels: ["frame"] },
      deadline_ms: 5000,
      activity: "idle",
    });
    await s.clock.sleep(0);
    s.ws.relay({
      t: "organ_res",
      req_id: s.ws.of("organ_req")[1]!.req_id,
      ok: true,
      data: [
        {
          device: "mcu1.gas",
          channel: "frame",
          value: null,
          image: { mime: "image/png", b64: "iVBORw0K", age_ms: 120 },
          ts: 5,
        },
      ],
    });
    await s.clock.sleep(0);
    expect(s.ws.of("result")[1]).toMatchObject({
      call_id: "c2",
      ok: true,
      image: { mime: "image/png", b64: "iVBORw0K", age_ms: 120 },
    });

    s.ws.relay({
      t: "call",
      call_id: "c3",
      tool: "command_device",
      args: { device: "mcu1.gas", command: "heat", args: { ms: 9000 } },
      deadline_ms: 5000,
      activity: "idle",
    });
    await s.clock.sleep(0);
    const q3 = s.ws.of("organ_req")[2]!;
    expect(q3).toMatchObject({ op: "command", command: "heat", args: { ms: 5000 } });
    s.ws.relay({
      t: "organ_res",
      req_id: q3.req_id,
      ok: true,
      data: { requested: { ms: 5000 }, measured: {}, clamped: false, reason: "completed", ms: 5000 },
    });
    await s.clock.sleep(0);
    expect(s.ws.of("result")[2]).toMatchObject({ ok: true, data: { clamped: true, reason: "clamped" } });

    s.ws.relay({
      t: "call",
      call_id: "c4",
      tool: "read_device",
      args: { device: "mcu1.gas" },
      deadline_ms: 5000,
      activity: "idle",
    });
    await s.clock.sleep(0);
    s.ws.relay({
      t: "organ_res",
      req_id: s.ws.of("organ_req")[3]!.req_id,
      ok: false,
      error: { code: "provider_stale", message: "mcu1 is silent" },
    });
    await s.clock.sleep(0);
    expect(s.ws.of("result")[3]).toMatchObject({
      ok: false,
      error: { code: "provider_stale", message: "mcu1 is silent", retryable: true },
    });
    s.client.close();
  });
  test("stop asks an organ with moving commands and reports what it verified", async () => {
    const s = await setup();
    await s.online();
    const READ_ONLY: DeviceSpec = { ...GAS, id: "cam1.x", provider: "cam1", commands: [] };
    s.ws.relay({
      t: "organs",
      organs: [
        { organ_id: "mcu1", state: "active", devices: [GAS] },
        { organ_id: "cam1", state: "active", devices: [READ_ONLY] },
      ],
    });
    await s.clock.sleep(0);
    const stopWith = async (answer?: (req_id: string) => RelayToRuntime) => {
      const asked = s.ws.of("organ_req").length,
        told = s.ws.of("stopped").length;
      s.ws.relay({ t: "stop", stop_id: `k${told}` });
      await s.clock.sleep(0);
      const reqs = s.ws.of("organ_req").slice(asked);
      expect(reqs).toMatchObject([{ organ_id: "mcu1", op: "stop" }]); // the read-only organ is not asked
      if (answer) s.ws.relay(answer(reqs[0]!.req_id));
      await s.alive(1000);
      return s.ws.of("stopped")[told];
    };
    expect(
      await stopWith((req_id) => ({ t: "organ_res", req_id, ok: true, data: { motors_stopped: true } })),
    ).toMatchObject({ t: "stopped", stop_id: "k0", motors_stopped: true });
    expect(
      await stopWith((req_id) => ({ t: "organ_res", req_id, ok: true, data: { motors_stopped: false } })),
    ).toMatchObject({ t: "stopped", motors_stopped: false });
    expect(await stopWith()).toMatchObject({ t: "stopped", motors_stopped: false }); // silent organ: not verified
    s.client.close();
  });
  test("an organ whose devices collide with a local id is reported, not swallowed", async () => {
    const s = await setup();
    await s.online();
    s.ws.relay({ t: "organs", organs: [{ organ_id: "mcu1", state: "active", devices: [{ ...GAS, id: "mock.gas" }] }] });
    await s.clock.sleep(0);
    expect(s.events).toContain("organ_error");
    s.ws.relay({ t: "call", call_id: "c1", tool: "describe_robot", args: {}, deadline_ms: 5000, activity: "idle" });
    await s.clock.sleep(0);
    expect((s.ws.of("result")[0] as any).data.provider_errors[0]).toMatchObject({ provider: "mcu1" });
    s.client.close();
  });
  test("a mode-switching read follows the activity the relay reports", async () => {
    const s = await setup();
    await s.online();
    const read = { device: "mock.color", channels: ["ambient_pct"] };
    s.ws.relay({ t: "call", call_id: "c1", tool: "read_device", args: read, deadline_ms: 5000, activity: "acting" });
    s.ws.relay({ t: "call", call_id: "c2", tool: "read_device", args: read, deadline_ms: 5000, activity: "idle" });
    await s.clock.sleep(0);
    expect(s.ws.of("result").find((r) => r.call_id === "c1")).toMatchObject({
      ok: false,
      error: { code: "busy", retryable: true },
    });
    expect(s.ws.of("result").find((r) => r.call_id === "c2")).toMatchObject({ ok: true, data: [{ value: 12 }] });
    expect(s.mock.modeSwitches).toBe(1);
    s.client.close();
  });
  test("an explicit read of an organ's inactive channel carries allow_mode_switch", async () => {
    const s = await setup();
    await s.online();
    const dev: DeviceSpec = {
      ...GAS,
      commands: [],
      channels: [
        { name: "ppm", type: "number", description: "Concentration." },
        {
          name: "raw",
          type: "number",
          active: false,
          mode_group: "m",
          description: "Raw counts. Needs a mode switch.",
        },
      ],
    };
    s.ws.relay({ t: "organs", organs: [{ organ_id: "mcu1", state: "active", devices: [dev] }] });
    await s.clock.sleep(0);
    s.ws.relay({
      t: "call",
      call_id: "c1",
      tool: "read_device",
      args: { device: "mcu1.gas", channels: ["raw"] },
      deadline_ms: 5000,
      activity: "idle",
    });
    await s.clock.sleep(0);
    expect(s.ws.of("organ_req")[0]).toMatchObject({ op: "read", channels: ["raw"], allow_mode_switch: true });
    s.client.close();
  });
  test("organs: no answer → timeout; stale → provider_stale; gone → unknown_device", async () => {
    const s = await setup();
    await s.online();
    s.ws.relay({ t: "organs", organs: [{ organ_id: "mcu1", state: "active", devices: [GAS] }] });
    await s.clock.sleep(0);
    const ask = async (id: string, waitMs: number) => {
      s.ws.relay({
        t: "call",
        call_id: id,
        tool: "read_device",
        args: { device: "mcu1.gas", channels: ["ppm"] },
        deadline_ms: 9000,
        activity: "idle",
      });
      await s.alive(waitMs);
      return s.ws.of("result").find((r) => r.call_id === id) as any;
    };
    expect((await ask("c1", 2500)).error).toMatchObject({ code: "timeout", retryable: true });
    s.ws.relay({ t: "organs", organs: [{ organ_id: "mcu1", state: "stale", devices: [GAS] }] });
    expect((await ask("c2", 500)).error).toMatchObject({ code: "provider_stale", retryable: true });
    s.ws.relay({ t: "organs", organs: [{ organ_id: "mcu1", state: "gone", devices: [GAS] }] });
    expect((await ask("c3", 500)).error.code).toBe("unknown_device");
    s.client.close();
  });
  test('a hot-plugged device is announced to the relay with {t:"devices"}', async () => {
    const s = await setup();
    await s.online();
    s.mock.plug({
      id: "mock.tof",
      provider: "mock",
      kind: "distance",
      roles: [],
      description: "Distance.",
      commands: [],
      channels: [{ name: "distance_cm", type: "number", unit: "cm", description: "Distance." }],
    });
    await s.clock.sleep(0);
    expect(s.ws.of("devices").length).toBe(1);
    expect(s.ws.of("devices")[0]!.devices.map((d) => d.id)).toContain("mock.tof");
    s.mock.unplug("mock.tof");
    await s.clock.sleep(0);
    expect(s.ws.of("devices")[1]!.devices.map((d) => d.id)).not.toContain("mock.tof");
    s.client.close();
  });
  test("announceDevices re-scans and sends the local devices", async () => {
    const s = await setup();
    await s.online();
    await s.client.announceDevices();
    expect(s.ws.of("devices")[0]!.devices.length).toBe(6);
    s.client.close();
  });
});

describe("RuntimeClient over a real WebSocket", () => {
  test("hello → welcome → call → result → close, with the default WebSocket and clock", async () => {
    const got: RuntimeToRelay[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => {
      done = r;
    });
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const m = JSON.parse(String(raw)) as RuntimeToRelay;
          got.push(m);
          if (m.t === "hello") {
            ws.send(JSON.stringify({ t: "welcome", session_id: "s" } satisfies RelayToRuntime));
            ws.send(
              JSON.stringify({
                t: "call",
                call_id: "c1",
                tool: "drive",
                args: { distance_cm: 3, speed_pct: 80 },
                deadline_ms: 5000,
                activity: "idle",
              } satisfies RelayToRuntime),
            );
          }
          if (m.t === "result") done();
        },
      },
    });
    const realish = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    const mock = new MockProvider({ clock: realish, deg_s_per_pct: 100 });
    const runtime = createRuntime({
      providers: [mock],
      profile: {
        id: "r1",
        roles: {},
        notes: [],
        limits: { max_speed_pct: 80, max_command_ms: 5000, max_drive_cm: 50, max_turn_deg: 360, max_program_ms: 5000 },
        drivetrain: {
          type: "differential",
          pair_device: "mock.pair",
          wheel_diameter_cm: 5.6,
          axle_track_cm: 12,
          forward_sign: 1,
        },
      },
    });
    const states: ClientState[] = [];
    const client = createRuntimeClient({
      runtime,
      url: `ws://localhost:${server.port}/ws/robot`,
      token: "t",
      onState: (s) => states.push(s),
    });
    client.connect();
    await finished;
    expect(got[0]).toMatchObject({ t: "hello", robot_id: "r1" });
    expect(got.find((m) => m.t === "result")).toMatchObject({ call_id: "c1", ok: true, data: { reason: "completed" } });
    client.close();
    expect(states).toEqual(["connecting", "handshaking", "online", "closed"]);
    expect(mock.stops).toBe(1);
    server.stop(true);
  });
});
