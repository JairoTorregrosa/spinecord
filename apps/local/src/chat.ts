// The chat of the 3D view (`--chat`, CONTRACT §6, experimental): one conversation with Claude for the person at
// the page, about the first twin of the view. Claude runs on the Claude Agent SDK (its own Claude Code, no
// built-in tool, no setting of this computer) and reaches the robots only through this process's own MCP
// server, attached in-process: the same catalog, checks, call log, view of the calls and robot state machines
// as a client on stdio. A stop never waits for Claude: the process stops every robot itself, then interrupts.
// Loaded by serve.ts only when the flag is given (a dynamic import), so a start without it loads nothing here.
import {
  CHAT_TEXT_MAX,
  CHAT_TRANSITIONS,
  isStopUtterance,
  type ChatOffCode,
  type ChatServerMessage,
  type ChatState,
  type ChatStatus,
  type ChatVia,
} from "../../twin-view/src/chat-messages";
import { activeProfile, antConfigDir, paidBy, Spend, type Account, type Env } from "../../../examples/assistant/setup";
import type { ChatConfig } from "./config";
import type { LocalRobot } from "./robot";
import { callTool } from "./tools";

/** Bound of one turn in steps (think, then use tools): the SDK cuts the turn there. */
export const CHAT_MAX_STEPS = 15;
/** Bound of one turn in time: past it the turn is interrupted and reported as failed. */
export const CHAT_TURN_MAX_MS = 120_000;
/** How long Claude Code may take to say who pays at start. */
export const CHAT_START_MAX_MS = 60_000;
/** How long a stopped turn may take to end once interrupted; past it the chat is `off`. */
export const CHAT_STOP_END_MAX_MS = 10_000;
/** Entries a page that opens late still sees. */
const HISTORY = 60;

// ---------------------------------------------------------------- who the robot is

/**
 * The robot's name: the `name` of its `describe_robot` data when it has one (a display name a person gave it),
 * else its id. The one place the chat reads a name from.
 */
export function robotName(describe: unknown, id: string): string {
  const d = describe as { name?: unknown; display_name?: unknown } | null;
  for (const v of [d?.name, d?.display_name])
    if (typeof v === "string" && v.trim() !== "" && v.trim().length <= 48) return v.trim();
  return id;
}

/** The persona in one sentence: the same words wherever a Claude speaks as this robot. */
export const persona = (name: string, id: string): string =>
  `You are ${name}, the robot with id ${id}: speak in the first person as this robot, never as an assistant who describes it.`;

/** The system prompt of the chat, from the robot's own description and the robots of the process. */
export function systemPrompt(robot: { id: string; name: string }, describe: unknown, robots: unknown): string {
  return `${persona(robot.name, robot.id)}

A person watches you move in a 3D simulator page and talks to you there, by voice or by typing, most often in Spanish. Answer in the language of their last message.

Everything you write is spoken aloud by your own voice. Write one or two short sentences, in plain words: no markdown, no lists, no emojis, no ids or JSON, numbers as a person says them.

Act, then say. When you are asked to move, call the tool first, then say in one sentence what you did and what you measured ("Avancé 30 centímetros y giré a la izquierda"). Never describe a move you did not make, and never announce a move before it is done.

Be honest. When a move ended early, stalled, was clamped or failed, say so plainly and why. You sense only what your devices read; never claim to see, hear or feel anything else. When you are not sure where you are or what is in front of you, read your sensors or say so.

A stop is not yours to decide: the page stops you at once when the person says "para" or presses stop, and tells you so. Do not move again until the person asks.

You reach your body only through the tools of the "spinecord" server: your robot_id is ${robot.id}. Units are centimetres and degrees; a positive turn is to the left.

Your body (describe_robot of ${robot.id}):
${JSON.stringify(describe)}

The robots of this process (list_robots):
${JSON.stringify(robots)}`;
}

/**
 * The environment of the chat's Claude Code: this process's own, without the markers of a Claude Code session
 * that may have started this process (a nested session behaves as a child of that one). Credentials stay:
 * ANTHROPIC_PROFILE, CLAUDE_CODE_OAUTH_TOKEN and the rest decide who pays, as for any Claude Code here.
 */
export function chatEnv(env: Env): Record<string, string> {
  const marker =
    /^(CLAUDECODE|CLAUDE_PID|CLAUDE_TMPDIR|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|CHILD_NOTES_DIR|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|EXPERIMENTAL_CODE_MODE))$/;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !marker.test(k)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------- the brain: what the chat needs of a Claude session

export type BrainEvent =
  /** More text of Claude in this turn. */
  | { kind: "text"; text: string }
  /** Claude began a tool call. */
  | { kind: "tool"; name: string }
  /** A tool call's result went back to Claude. */
  | { kind: "tool_done" }
  /** The turn ended. `cost_usd` is the SDK's running total of the session (it may start again at 0 on a reset). */
  | { kind: "end"; ok: boolean; running_usd: number; error?: string }
  /** The session ended, by itself or because it failed. */
  | { kind: "closed"; error?: string };

export interface Brain {
  /** Starts the session. Resolves with who pays ("paid by: ..."); throws when nobody can or the start fails. */
  start(onEvent: (e: BrainEvent) => void): Promise<string>;
  /** Hands one message of the person to Claude: a turn begins. */
  send(text: string): void;
  /** Interrupts the turn that runs: the SDK cancels the tool call in flight, and the turn ends. */
  interrupt(): Promise<void>;
  close(): void;
}

/** Thrown by a brain's start when no credential of this computer can pay: the page words it as "sign in". */
export class NoLogin extends Error {}

/** A brain on the Claude Agent SDK. `server` is the in-process MCP server of this process (buildServer). */
export function sdkBrain(o: { model: string; prompt: string; server: unknown; usd: number }): Brain {
  type SDK = typeof import("@anthropic-ai/claude-agent-sdk");
  type UserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
  const env = chatEnv(process.env);
  const outbox: string[] = [];
  let wake = () => {};
  let open = true;
  async function* input(): AsyncGenerator<UserMessage> {
    while (true) {
      const text = outbox.shift();
      if (text !== undefined)
        yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
      else if (!open) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  let session: ReturnType<SDK["query"]> | null = null;
  return {
    async start(onEvent) {
      const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as SDK;
      session = query({
        prompt: input(),
        options: {
          model: o.model,
          systemPrompt: o.prompt,
          mcpServers: { spinecord: { type: "sdk", name: "spinecord", instance: o.server as never } },
          strictMcpConfig: true,
          tools: [],
          allowedTools: ["mcp__spinecord__*"],
          permissionMode: "dontAsk",
          settingSources: [],
          persistSession: false,
          verbatimPrompts: true,
          includePartialMessages: true,
          maxTurns: CHAT_MAX_STEPS,
          maxBudgetUsd: o.usd,
          effort: "low",
          env,
        },
      });
      const s = session;
      void (async () => {
        let error: string | undefined;
        let turnError: string | undefined;
        try {
          for await (const m of s) {
            if (m.type === "system" && m.subtype === "init") {
              const server = m.mcp_servers.find((x) => x.name === "spinecord");
              const foreign = m.tools.filter((t) => !t.startsWith("mcp__spinecord__"));
              if (server?.status !== "connected" || foreign.length > 0) {
                error = `the chat's Claude Code is not wired as asked: spinecord ${server?.status ?? "missing"}, other tools: ${foreign.join(", ") || "none"}`;
                break;
              }
            } else if (m.type === "stream_event") {
              const e = m.event as {
                type: string;
                content_block?: { type: string; name?: string };
                delta?: { type: string; text?: string };
              };
              if (e.type === "content_block_start" && e.content_block?.type === "tool_use")
                onEvent({ kind: "tool", name: (e.content_block.name ?? "").replace(/^mcp__spinecord__/, "") });
              else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text)
                onEvent({ kind: "text", text: e.delta.text });
            } else if (m.type === "user") {
              const content = (m.message as { content?: unknown }).content;
              if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === "tool_result"))
                onEvent({ kind: "tool_done" });
            } else if (m.type === "assistant" && m.error) {
              turnError = m.error === "authentication_failed" ? "Claude did not accept the login" : m.error;
            } else if (m.type === "result") {
              const ok = m.subtype === "success" && !m.is_error;
              const why =
                turnError ??
                (m.subtype === "success" ? (m.is_error ? String(m.result).slice(0, 300) : undefined) : m.subtype);
              onEvent({ kind: "end", ok, running_usd: m.total_cost_usd, ...(ok ? {} : { error: why }) });
              turnError = undefined;
            }
          }
        } catch (e) {
          error = (e as Error).message;
        }
        onEvent({ kind: "closed", ...(error === undefined ? {} : { error }) });
      })();
      const account = (await Promise.race([
        s.accountInfo(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Claude Code did not say who pays within ${CHAT_START_MAX_MS / 1000} s`)),
            CHAT_START_MAX_MS,
          ),
        ),
      ])) as Account;
      try {
        return paidBy(account, process.env, activeProfile(antConfigDir(process.env)));
      } catch (e) {
        throw new NoLogin((e as Error).message);
      }
    },
    send(text) {
      outbox.push(text);
      wake();
    },
    async interrupt() {
      await session?.interrupt();
    },
    close() {
      open = false;
      wake();
      session?.close();
    },
  };
}

// ---------------------------------------------------------------- the chat

type Log = (ev: string, fields?: Record<string, unknown>) => void;
type Send = (m: ChatServerMessage) => void;

/** What the view's listener needs of the chat (src/view.ts). */
export interface ViewChat {
  /** For a page that opens: the chat's status and what it missed. */
  hello(): { status: ChatStatus; history: ChatServerMessage[] };
  /** A message of a page whose `t` starts with "chat_"; `reply` answers that page alone. */
  message(m: Record<string, unknown>, reply: Send): void;
  /** Where the chat sends what every page sees. */
  attach(broadcast: Send): void;
}

export interface ChatOptions {
  robots: readonly LocalRobot[];
  /** The robot the chat speaks as: the first twin of the view. */
  robotId: string;
  config: ChatConfig;
  log: Log;
  /** Makes the brain once the system prompt is known. */
  brain: (prompt: string) => Brain;
}

export class Chat implements ViewChat {
  private state: ChatState = "starting";
  private off: { code: ChatOffCode; why: string } | null = null;
  private paid: string | null = null;
  private readonly spend = new Spend();
  private broadcast: Send = () => {};
  private readonly history: ChatServerMessage[] = [];
  private brain: Brain | null = null;
  private turn = 0;
  private turnAt = 0;
  /** When this turn's first text and first tool call came, ms after the person's message: the log's latency. */
  private firstText: number | null = null;
  private firstTool: number | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private robot: { id: string; name: string };

  constructor(private readonly o: ChatOptions) {
    this.robot = { id: o.robotId, name: o.robotId };
  }

  attach(broadcast: Send): void {
    this.broadcast = broadcast;
  }

  status(): ChatStatus {
    return {
      t: "chat",
      state: this.state,
      robot: { ...this.robot },
      model: this.o.config.model,
      paid_by: this.paid,
      spent_usd: Math.round(this.spend.total * 1e6) / 1e6,
      budget_usd: this.o.config.usd,
      ...(this.off ? { off: { ...this.off } } : {}),
    };
  }

  hello() {
    return { status: this.status(), history: this.history.map((m) => ({ ...m })) };
  }

  /** The chat's state, for tests and the end of the process. */
  get current(): ChatState {
    return this.state;
  }

  /** Builds the prompt from the robot's own description, starts the brain, asks who pays. Never throws. */
  async start(): Promise<void> {
    try {
      const describe = await callTool(this.o.robots, "describe_robot", { robot_id: this.o.robotId });
      const listing = await callTool(this.o.robots, "list_robots", {});
      if (!describe.envelope.ok)
        throw new Error(`describe_robot ${this.o.robotId}: ${describe.envelope.error.message}`);
      const data = describe.envelope.data;
      this.robot = { id: this.o.robotId, name: robotName(data, this.o.robotId) };
      const prompt = systemPrompt(this.robot, data, listing.envelope.ok ? listing.envelope.data : null);
      const t0 = performance.now();
      this.brain = this.o.brain(prompt);
      this.paid = await this.brain.start((e) => this.onBrain(e));
      if (this.state !== "starting") return; // the session closed while it started
      this.o.log("chat_ready", { model: this.o.config.model, ms: Math.round(performance.now() - t0) });
      this.go("idle");
    } catch (e) {
      const why = (e as Error).message;
      this.shutDown(e instanceof NoLogin ? "no_login" : "start_failed", why);
    }
  }

  message(m: Record<string, unknown>, reply: Send): void {
    if (m.t === "chat_stop") return void this.stop();
    if (m.t !== "chat_send")
      return reply({ t: "chat_refused", code: "invalid", error: `unknown chat message ${JSON.stringify(m.t)}` });
    const text = typeof m.text === "string" ? m.text.trim() : "";
    const via: ChatVia | null = m.via === "typed" || m.via === "voice" ? m.via : null;
    if (!text || text.length > CHAT_TEXT_MAX || !via)
      return reply({
        t: "chat_refused",
        code: "invalid",
        error: `chat_send needs text (1..${CHAT_TEXT_MAX} characters) and via "typed" or "voice"`,
      });
    // a stop word is never a message for Claude, whatever the chat is doing
    if (isStopUtterance(text)) return void this.stop();
    if (this.state === "off")
      return reply({ t: "chat_refused", code: "off", error: this.off?.why ?? "the chat is off" });
    if (this.state !== "idle")
      return reply({
        t: "chat_refused",
        code: "busy",
        error: `the chat is ${this.state}: wait for the answer, or stop`,
      });
    this.turn += 1;
    this.turnAt = performance.now();
    this.firstText = this.firstTool = null;
    this.keep({ t: "chat_user", turn: this.turn, text, via, at: Date.now() });
    this.go("thinking");
    const turn = this.turn;
    this.turnTimer = setTimeout(() => {
      if (this.turn !== turn || (this.state !== "thinking" && this.state !== "acting")) return;
      this.o.log("chat_turn_timeout", { turn, ms: CHAT_TURN_MAX_MS });
      void this.interruptTurn(`the turn took longer than ${CHAT_TURN_MAX_MS / 1000} s`);
    }, CHAT_TURN_MAX_MS);
    this.brain!.send(text);
  }

  /**
   * Stops every robot of the process at once, then interrupts the turn that runs. The robots' stop never waits
   * for Claude: it runs beside the interrupt, not behind it.
   */
  async stop(): Promise<void> {
    const t0 = performance.now();
    const running = this.state === "thinking" || this.state === "acting";
    const robots = Promise.all(
      this.o.robots.map(async (r) => {
        const out = await callTool(this.o.robots, "stop", { robot_id: r.id });
        const d = out.envelope.ok ? (out.envelope.data as { motors_stopped?: unknown }) : null;
        return {
          id: r.id,
          ok: out.envelope.ok,
          motors_stopped: typeof d?.motors_stopped === "boolean" ? d.motors_stopped : null,
        };
      }),
    );
    const interrupted = running ? this.interruptTurn(null) : Promise.resolve();
    const stopped = await robots;
    const ms = Math.round(performance.now() - t0);
    this.o.log("chat_stop", { ms, robots: stopped.map((r) => r.id) });
    this.keep({ t: "chat_stopped", ms, robots: stopped });
    await interrupted;
  }

  /** Ends the chat for good (the process is ending). */
  close(): void {
    this.shutDown("ending", "the process is ending");
  }

  // ---------------------------------------------------------------- internals

  /** Interrupts the running turn; `why` null for a stop of the person, else the failure to report. */
  private async interruptTurn(why: string | null): Promise<void> {
    if (this.state !== "thinking" && this.state !== "acting") return;
    this.pendingError = why;
    this.go("stopping");
    const turn = this.turn;
    this.stopTimer = setTimeout(() => {
      if (this.state === "stopping" && this.turn === turn)
        this.shutDown(
          "session_ended",
          `the turn did not end ${CHAT_STOP_END_MAX_MS / 1000} s after it was interrupted`,
        );
    }, CHAT_STOP_END_MAX_MS);
    try {
      await this.brain?.interrupt();
    } catch (e) {
      this.o.log("chat_interrupt_failed", { error: (e as Error).message });
    }
  }
  private pendingError: string | null = null;

  private onBrain(e: BrainEvent): void {
    switch (e.kind) {
      case "text":
        this.firstText ??= Math.round(performance.now() - this.turnAt);
        // after a stop nothing more of that turn is said
        if (this.state === "thinking" || this.state === "acting")
          this.keep({ t: "chat_delta", turn: this.turn, text: e.text });
        return;
      case "tool":
        this.firstTool ??= Math.round(performance.now() - this.turnAt);
        if (this.state === "thinking") this.go("acting");
        return;
      case "tool_done":
        if (this.state === "acting") this.go("thinking");
        return;
      case "end": {
        if (this.state !== "thinking" && this.state !== "acting" && this.state !== "stopping") {
          this.o.log("chat_unexpected_end", { state: this.state });
          return;
        }
        this.clearTimers();
        const stopped = this.state === "stopping";
        const cost = this.spend.add(e.running_usd);
        const ms = Math.round(performance.now() - this.turnAt);
        const error = this.pendingError ?? (stopped ? undefined : e.error);
        this.pendingError = null;
        const ok = e.ok && !stopped;
        this.o.log("chat_turn", {
          turn: this.turn,
          ok,
          stopped,
          cost_usd: cost,
          ms,
          first_text_ms: this.firstText,
          first_tool_ms: this.firstTool,
          ...(error ? { error } : {}),
        });
        this.keep({
          t: "chat_end",
          turn: this.turn,
          ok,
          cost_usd: cost,
          ms,
          ...(error ? { error } : {}),
          ...(stopped ? { stopped: true } : {}),
        });
        if (this.spend.total >= this.o.config.usd)
          return this.shutDown("budget", `the budget of $${this.o.config.usd.toFixed(2)} is spent`);
        this.go("idle");
        return;
      }
      case "closed":
        if (this.state !== "off")
          this.shutDown("session_ended", e.error ? `the session failed: ${e.error}` : "the session ended");
        return;
    }
  }

  private go(to: ChatState): void {
    const from = this.state;
    if (from === to) return;
    if (!CHAT_TRANSITIONS[from].includes(to)) throw new Error(`chat: illegal transition ${from} → ${to}`);
    this.state = to;
    this.o.log("chat", { from, to, ...(this.off ? { code: this.off.code } : {}) });
    this.broadcast(this.status());
  }

  private shutDown(code: ChatOffCode, why: string): void {
    if (this.state === "off") return;
    this.clearTimers();
    this.off = { code, why };
    this.o.log("chat_off", { code, why });
    this.go("off");
    try {
      this.brain?.close();
    } catch {
      // a session that is gone has nothing to close
    }
  }

  private clearTimers(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.turnTimer = this.stopTimer = null;
  }

  /** Sends to every page and keeps it for a page that opens later; a turn's deltas are kept as one text. */
  private keep(m: ChatServerMessage): void {
    this.broadcast(m);
    const last = this.history.at(-1);
    if (m.t === "chat_delta" && last?.t === "chat_delta" && last.turn === m.turn) {
      this.history[this.history.length - 1] = { ...last, text: last.text + m.text };
      return;
    }
    this.history.push({ ...m });
    if (this.history.length > HISTORY) this.history.shift();
  }
}

/** The chat of a process, on the Claude Agent SDK. `server` is made once the view exists (it watches the calls). */
export function createChat(o: Omit<ChatOptions, "brain">, server: () => unknown): Chat {
  return new Chat({
    ...o,
    brain: (prompt) => sdkBrain({ model: o.config.model, prompt, server: server(), usd: o.config.usd }),
  });
}
