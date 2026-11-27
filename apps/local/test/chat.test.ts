// The chat of the 3D view (`--chat`, CONTRACT §6, experimental): its flags, its protocol over the view's real
// socket, the stop that never waits for Claude, and a failing turn reported. Claude is a fake brain here: the
// real one (the Claude Agent SDK) costs money and needs a login, and is exercised by hand (the README of the chat).
import { afterEach, describe, expect, test } from "bun:test";
import { isStopUtterance, type ChatServerMessage } from "../../twin-view/src/chat-messages";
import type { ServerMessage } from "../../twin-view/src/messages";
import { buildViewPage } from "../../twin-view/view-build";
import { ROBOT_NAME_RULE } from "../../../packages/protocol/tools";
import { Chat, NoLogin, chatEnv, persona, robotName, systemPrompt, type Brain, type BrainEvent } from "../src/chat";
import { DEFAULT_CHAT_MODEL, DEFAULT_CHAT_USD, loadConfig } from "../src/config";
import { buildFleet, type Fleet } from "../src/sources";
import { callTool } from "../src/tools";
import { serveView, type ViewServer } from "../src/view";
import { until } from "./client";

describe("--chat flags", () => {
  test("--chat needs --view; its model and budget have defaults; --chat-model and --chat-usd need --chat", () => {
    expect(loadConfig(["--twin", "--view"]).view).toEqual({ port: 8769 });
    expect(loadConfig(["--twin", "--view", "--chat"]).view?.chat).toEqual({
      model: DEFAULT_CHAT_MODEL,
      usd: DEFAULT_CHAT_USD,
    });
    expect(
      loadConfig(["--view", "--chat", "--chat-model", "claude-sonnet-5-5", "--chat-usd", "0.5"]).view?.chat,
    ).toEqual({ model: "claude-sonnet-5-5", usd: 0.5 });
    expect(() => loadConfig(["--twin", "--chat"])).toThrow(/--chat needs --view/);
    expect(() => loadConfig(["--view", "--chat-model", "x-y-z"])).toThrow(/--chat-model needs --chat/);
    expect(() => loadConfig(["--view", "--chat", "--chat-usd", "0"])).toThrow(/budget must be a number/);
    expect(() => loadConfig(["--view", "--chat", "--chat-model", "Bad Model"])).toThrow(/model id/);
  });
});

describe("the words of the chat", () => {
  test("a stop word stops; a sentence that holds one is a message ('para' is also 'for')", () => {
    for (const s of ["para", "¡Para!", "PARA YA", "alto", "Stop.", "detente", "quieto robot", "ya"])
      expect(isStopUtterance(s)).toBe(true);
    for (const s of ["avanza para adelante", "para qué sirve el sensor", "gira", "", "ya está bien", "para de girar"])
      expect(isStopUtterance(s)).toBe(false);
  });
  test("the robot's name comes from describe_robot when it has one, else its id; the persona is one sentence", () => {
    expect(robotName({ name: "Rayo" }, "orugas-sim")).toBe("Rayo");
    expect(robotName({ display_name: " Luna " }, "r1-sim")).toBe("Luna");
    expect(robotName({ id: "r1-sim" }, "r1-sim")).toBe("r1-sim");
    expect(persona("Rayo", "orugas-sim")).toBe(
      "You are Rayo, the robot with robot_id orugas-sim, never an assistant who describes it.",
    );
    expect(persona("r1-sim", "r1-sim")).toContain("first person as this robot under its id");
    const p = systemPrompt({ id: "orugas-sim", name: "Rayo" }, { id: "orugas-sim" }, { robots: [] });
    expect(p.startsWith(persona("Rayo", "orugas-sim"))).toBe(true);
    // the server's own rule for a robot's name, imported, never written again in other words
    expect(p).toContain(ROBOT_NAME_RULE);
    expect(p.split("speak in the first person").length - 1).toBe(1);
    expect(p).toContain("your robot_id is orugas-sim");
  });
  test("the chat's Claude Code loses the markers of a Claude Code session, never a credential", () => {
    const env = chatEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "x",
      ANTHROPIC_PROFILE: "credits",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      PATH: "/bin",
    });
    expect(env).toEqual({ ANTHROPIC_PROFILE: "credits", CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/bin" });
  });
});

/** Claude as a script: what the chat sent it, and the events a test makes it emit. */
class FakeBrain implements Brain {
  sent: string[] = [];
  interrupts = 0;
  closed = false;
  emit: (e: BrainEvent) => void = () => {};
  onSend: (text: string) => void = () => {};
  onInterrupt: () => void = () => {};
  constructor(private readonly paid: string | Error = "paid by: a test") {}
  async start(onEvent: (e: BrainEvent) => void) {
    this.emit = onEvent;
    if (this.paid instanceof Error) throw this.paid;
    return this.paid;
  }
  send(text: string) {
    this.sent.push(text);
    this.onSend(text);
  }
  async interrupt() {
    this.interrupts += 1;
    this.onInterrupt();
  }
  close() {
    this.closed = true;
  }
}

const open: { fleet: Fleet; view: ViewServer; sockets: WebSocket[] }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    for (const s of o.sockets) s.close();
    o.view.stop();
    await o.fleet.shutdown();
  }
});

async function rig(brain: FakeBrain, usd = 1) {
  const events: Record<string, unknown>[] = [];
  const log = (ev: string, fields?: Record<string, unknown>) => void events.push({ ev, ...fields });
  const fleet = await buildFleet(loadConfig(["--twin"]), { log });
  const twins = fleet.robots.map((r) => ({
    id: r.id,
    brick: fleet.bricks.get(r.id)!,
    sim: fleet.sims.get(r.id)!,
    robot: r,
  }));
  let prompt = "";
  const chat = new Chat({
    robots: fleet.robots,
    robotId: "r1-sim",
    config: { model: "claude-test", usd },
    log,
    brain: (p) => ((prompt = p), brain),
  });
  const view = serveView(twins, 0, { page: await buildViewPage(), log, rateHz: 5, chat });
  const entry = { fleet, view, sockets: [] as WebSocket[] };
  open.push(entry);
  await chat.start();
  const connect = async () => {
    const ws = new WebSocket(`${view.url.replace("http", "ws")}ws`, {
      headers: { origin: new URL(view.url).origin },
    } as never);
    entry.sockets.push(ws);
    const got: ServerMessage[] = [];
    ws.onmessage = (e) => void got.push(JSON.parse(String(e.data)) as ServerMessage);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the socket did not open"));
    });
    const next = async <T extends ServerMessage>(pred: (m: ServerMessage) => boolean, from = 0) => {
      let hit: ServerMessage | undefined;
      await until("a message from the view", () => (hit = got.slice(from).find(pred)) !== undefined, 8000);
      return hit as T;
    };
    return { ws, got, next, send: (m: Record<string, unknown>) => ws.send(JSON.stringify(m)) };
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) =>
    (await callTool(fleet.robots, name, { robot_id: "r1-sim", ...args })).envelope as {
      ok: boolean;
      data: any;
      error?: any;
    };
  return { chat, fleet, view, events, connect, tool, prompt: () => prompt };
}

const status = (m: ServerMessage): m is Extract<ChatServerMessage, { t: "chat" }> => m.t === "chat";

describe("the chat over the view's socket", () => {
  test("hello carries the chat; a typed message is a turn: shown, streamed, ended, then idle again", async () => {
    const brain = new FakeBrain();
    const r = await rig(brain);
    expect(r.prompt().startsWith(persona("r1-sim", "r1-sim"))).toBe(true);
    const p = await r.connect();
    const hello = await p.next<Extract<ServerMessage, { t: "hello" }>>((m) => m.t === "hello");
    expect(hello.chat?.status).toMatchObject({ state: "idle", paid_by: "paid by: a test", model: "claude-test" });
    expect(hello.chat?.status.robot).toEqual({ id: "r1-sim", name: "r1-sim" });

    brain.onSend = () => {
      brain.emit({ kind: "text", text: "Avancé " });
      brain.emit({ kind: "text", text: "10 cm." });
      brain.emit({ kind: "end", ok: true, running_usd: 0.002 });
    };
    p.send({ t: "chat_send", text: "avanza 10 cm", via: "typed" });
    const user = await p.next<Extract<ServerMessage, { t: "chat_user" }>>((m) => m.t === "chat_user");
    expect(user).toMatchObject({ turn: 1, text: "avanza 10 cm", via: "typed" });
    const end = await p.next<Extract<ServerMessage, { t: "chat_end" }>>((m) => m.t === "chat_end");
    expect(end).toMatchObject({ turn: 1, ok: true, cost_usd: 0.002 });
    expect(
      p.got
        .filter((m) => m.t === "chat_delta")
        .map((m) => (m as { text: string }).text)
        .join(""),
    ).toBe("Avancé 10 cm.");
    expect(brain.sent).toEqual(["avanza 10 cm"]);
    expect(r.chat.current).toBe("idle");
    // a page that opens later sees the turn as one text
    const late = await r.connect();
    const h2 = await late.next<Extract<ServerMessage, { t: "hello" }>>((m) => m.t === "hello");
    expect(h2.chat?.history.map((m) => m.t)).toEqual(["chat_user", "chat_delta", "chat_end"]);
    expect(h2.chat?.status.spent_usd).toBe(0.002);
    // the log holds no text of the person or of Claude
    expect(JSON.stringify(r.events)).not.toContain("avanza");
    expect(JSON.stringify(r.events)).not.toContain("Avancé");
  });

  test("refused: a second message while a turn runs, a message that is too long or has no via", async () => {
    const brain = new FakeBrain();
    const r = await rig(brain);
    const p = await r.connect();
    p.send({ t: "chat_send", text: "gira", via: "voice" });
    await p.next((m) => m.t === "chat_user");
    p.send({ t: "chat_send", text: "y ahora avanza", via: "voice" });
    expect(await p.next((m) => m.t === "chat_refused")).toMatchObject({ code: "busy" });
    p.send({ t: "chat_send", text: "x".repeat(401), via: "typed" });
    p.send({ t: "chat_send", text: "hola" });
    await until("two refusals", () => p.got.filter((m) => m.t === "chat_refused").length === 3, 4000);
    expect(p.got.filter((m) => m.t === "chat_refused").map((m) => (m as { code: string }).code)).toEqual([
      "busy",
      "invalid",
      "invalid",
    ]);
    expect(brain.sent).toEqual(["gira"]);
  });

  test("a failing turn is reported, and the chat takes the next one", async () => {
    const brain = new FakeBrain();
    const r = await rig(brain);
    const p = await r.connect();
    brain.onSend = () => brain.emit({ kind: "end", ok: false, running_usd: 0.001, error: "overloaded_error" });
    p.send({ t: "chat_send", text: "hola", via: "typed" });
    expect(await p.next((m) => m.t === "chat_end")).toMatchObject({ ok: false, error: "overloaded_error" });
    expect(r.chat.current).toBe("idle");
    brain.onSend = () => brain.emit({ kind: "end", ok: true, running_usd: 0.002 });
    p.send({ t: "chat_send", text: "otra vez", via: "typed" });
    await until("the second turn ends", () => p.got.filter((m) => m.t === "chat_end").length === 2, 4000);
    expect(r.chat.status().spent_usd).toBe(0.002);
  });

  test("'para' stops a drive the chat started at once, without waiting for Claude, and ends the turn", async () => {
    const brain = new FakeBrain();
    const r = await rig(brain);
    const p = await r.connect();
    let drive: Promise<{ ok: boolean; data: any }> | null = null;
    // Claude's tool call: the long, slow drive a person would want to stop
    brain.onSend = () => {
      brain.emit({ kind: "tool", name: "drive" });
      drive = r.tool("drive", { distance_cm: 100, speed_pct: 20 });
    };
    // Claude takes its time to let go: the stop must not wait for it
    brain.onInterrupt = () => setTimeout(() => brain.emit({ kind: "end", ok: false, running_usd: 0.003 }), 400);
    p.send({ t: "chat_send", text: "avanza un metro", via: "voice" });
    await p.next((m) => status(m) && m.state === "acting");
    await until(
      "the robot moves",
      async () =>
        (await r.tool("read_all")).data.readings.length > 0 && r.fleet.robots[0]!.view().activity === "acting",
      4000,
    );
    const t0 = performance.now();
    p.send({ t: "chat_send", text: "¡Para!", via: "voice" });
    const stopped = await p.next<Extract<ServerMessage, { t: "chat_stopped" }>>((m) => m.t === "chat_stopped");
    const moved = await drive!;
    expect(moved.data.reason).toBe("preempted");
    expect(stopped.robots).toEqual([{ id: "r1-sim", ok: true, motors_stopped: true }]);
    expect(stopped.ms).toBeLessThan(400); // before Claude let go
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(brain.interrupts).toBe(1);
    expect(brain.sent).toEqual(["avanza un metro"]); // "para" never reached Claude
    expect(await p.next((m) => m.t === "chat_end")).toMatchObject({ ok: false, stopped: true });
    expect(r.chat.current).toBe("idle");
    expect(r.events.some((e) => e.ev === "chat_stop")).toBe(true);
  });

  test("the stop button stops a drive another client started, while the chat is idle", async () => {
    const r = await rig(new FakeBrain());
    const p = await r.connect();
    const drive = r.tool("drive", { distance_cm: 100, speed_pct: 20 });
    await until("the robot moves", () => r.fleet.robots[0]!.view().activity === "acting", 4000);
    p.send({ t: "chat_stop" });
    expect((await drive).data.reason).toBe("preempted");
    await p.next((m) => m.t === "chat_stopped");
    expect(r.chat.current).toBe("idle");
  });

  test("a stop passes even when the page is over its limit of actions", async () => {
    const r = await rig(new FakeBrain());
    const p = await r.connect();
    const drive = r.tool("drive", { distance_cm: 100, speed_pct: 20 });
    await until("the robot moves", () => r.fleet.robots[0]!.view().activity === "acting", 4000);
    for (let i = 0; i < 70; i++) p.send({ t: "restore_nothing", req: i, id: "r1-sim" });
    p.send({ t: "chat_stop" });
    expect((await drive).data.reason).toBe("preempted");
    await p.next((m) => m.t === "chat_stopped");
    expect(p.got.some((m) => m.t === "reply" && !m.ok && m.code === "too_fast")).toBe(true);
  });

  test("no login: the chat is off with the reason, the view goes on; the budget turns it off too", async () => {
    const r = await rig(new FakeBrain(new NoLogin("Claude Code has no login on this computer.")));
    expect(r.chat.status()).toMatchObject({ state: "off", off: { code: "no_login" } });
    const p = await r.connect();
    p.send({ t: "chat_send", text: "hola", via: "typed" });
    expect(await p.next((m) => m.t === "chat_refused")).toMatchObject({ code: "off" });
    expect((await r.tool("read_all")).ok).toBe(true);

    const brain = new FakeBrain();
    const b = await rig(brain, 0.01);
    brain.onSend = () => brain.emit({ kind: "end", ok: true, running_usd: 0.02 });
    const q = await b.connect();
    q.send({ t: "chat_send", text: "hola", via: "typed" });
    await q.next((m) => status(m) && m.state === "off");
    expect(b.chat.status().off?.code).toBe("budget");
    expect(brain.closed).toBe(true);
  });

  test("the session that ends by itself leaves the chat off, never stuck", async () => {
    const brain = new FakeBrain();
    const r = await rig(brain);
    brain.emit({ kind: "closed", error: "Claude Code exited with code 1" });
    expect(r.chat.status()).toMatchObject({ state: "off", off: { code: "session_ended" } });
    expect(r.chat.status().off?.why).toContain("exited with code 1");
  });
});

describe("without --chat", () => {
  test("hello carries no chat, and a chat message is an unknown action as before", async () => {
    const log = () => {};
    const fleet = await buildFleet(loadConfig(["--twin"]), { log });
    const twins = fleet.robots.map((r) => ({
      id: r.id,
      brick: fleet.bricks.get(r.id)!,
      sim: fleet.sims.get(r.id)!,
      robot: r,
    }));
    const view = serveView(twins, 0, { page: await buildViewPage(), log, rateHz: 5 });
    const entry = { fleet, view, sockets: [] as WebSocket[] };
    open.push(entry);
    const ws = new WebSocket(`${view.url.replace("http", "ws")}ws`, {
      headers: { origin: new URL(view.url).origin },
    } as never);
    entry.sockets.push(ws);
    const got: ServerMessage[] = [];
    ws.onmessage = (e) => void got.push(JSON.parse(String(e.data)) as ServerMessage);
    await until("hello", () => got.some((m) => m.t === "hello"), 4000);
    expect("chat" in (got.find((m) => m.t === "hello") as object)).toBe(false);
    ws.send(JSON.stringify({ t: "chat_send", req: 7, text: "hola", via: "typed" }));
    await until("the reply", () => got.some((m) => m.t === "reply"), 4000);
    expect(got.find((m) => m.t === "reply")).toMatchObject({ req: 7, ok: false, code: "invalid" });
  });
});
