// speaker.speak on the fake brick: the real bridge with a stub `espeak` and a stub `aplay` on its PATH.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { RuntimeError } from "../../protocol/types";
import type { DeviceSpec } from "../../protocol/types";
import { BRICK_WATCHDOG_MS, Ev3devProvider, EXAMPLE_EV3DEV_HARDWARE, type LineTransport } from "../src/provider";
import { BRIDGE_FILE } from "../src/ssh";
import { FAKE_HAS_SPEECH, FakeBrick, findPython, pythonPath } from "./fake-brick";

const python = findPython();
if (!python || !FAKE_HAS_SPEECH)
  console.warn(
    "SKIPPED: the speech tests run bridge/ev3dev_bridge.py with a local Python 3 and /bin/sh stubs of espeak and aplay; this machine lacks one of them.",
  );
const speechTest = python && FAKE_HAS_SPEECH ? test : test.skip;

const VOICES = ["af", "en", "es", "es-la", "pt-br"];
const HARDWARE = { ...EXAMPLE_EV3DEV_HARDWARE, speech_volume_pct: 80 };
const never = new AbortController().signal;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(5);
  }
  return true;
};
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof RuntimeError ? e.code : `not a RuntimeError: ${e}`;
  }
  return "resolved";
}

const open: { brick: FakeBrick; provider?: Ev3devProvider; transport?: LineTransport }[] = [];
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.provider?.close().catch(() => {});
    await o.transport?.close().catch(() => {});
    o.brick.dispose();
  }
});
function setup(speech: { voices: string[] } | "none" = { voices: VOICES }) {
  const brick = new FakeBrick({ motors: [{ port: "B" }, { port: "C" }], sensors: [], speech });
  const provider = new Ev3devProvider(brick.transport(python!), {
    limits: { max_speed_pct: 60, max_command_ms: 15000 },
    hardware: HARDWARE,
  });
  open.push({ brick, provider });
  return { brick, provider };
}
const speaker = (specs: DeviceSpec[]) => specs.find((s) => s.id === "ev3.speaker")!;

describe("speaker.speak", () => {
  speechTest("is declared only when the brick has espeak and aplay, with the brick's voices as an enum", async () => {
    const spec = speaker(await setup().provider.devices());
    expect(spec.commands.map((c) => c.name)).toEqual(["tone", "beep", "speak"]);
    const speak = spec.commands[2]!;
    expect(speak).toMatchObject({ moves: false, bound: { kind: "ms", max: 15000 } });
    expect(speak.params).toMatchObject({
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1, maxLength: 200 },
        voice: { type: "string", enum: VOICES, default: "es-la" },
        rate_wpm: { type: "number", minimum: 80, maximum: 300, default: 140 },
      },
    });

    const none = speaker(await setup("none").provider.devices());
    expect(none.commands.map((c) => c.name)).toEqual(["tone", "beep"]);
    expect(none.description).toContain("no speak command (no `espeak` or `aplay` program on its PATH)");

    // without es-la the default voice is en
    const english = speaker(await setup({ voices: ["de", "en"] }).provider.devices());
    expect((english.commands[2]!.params.properties.voice as { default: string }).default).toBe("en");
  });

  speechTest("says the text through espeak | aplay without a shell and returns when the audio has ended", async () => {
    const { provider, brick } = setup();
    brick.setSpeech({ seconds: 0.4 });
    const text = '-v x; touch pwned $(id) `id` "quoted"';
    const t0 = Date.now();
    const r = await provider.command("ev3.speaker", "speak", { text: `  ${text}\n` }, never);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350); // it blocked for the playback
    expect(r).toMatchObject({
      reason: "completed",
      clamped: false,
      measured: { voice: "es-la", rate_wpm: 140, chars: text.length, spoken: true },
    });
    // volume 80 % -> espeak amplitude 160; "--" keeps a text that starts with "-" from being read as options
    expect(brick.spoken("espeak.args")!.split("\n")).toEqual([
      "-v",
      "es-la",
      "-s",
      "140",
      "-a",
      "160",
      "--stdout",
      "--",
      text,
    ]);
    expect(brick.spoken("aplay.args")).toBe("-q");
    expect(brick.spoken("aplay.audio")).toBe("RIFFfake");
    expect(brick.spoken("aplay.done")).toBe("done");

    const fast = await provider.command("ev3.speaker", "speak", { text: "hi", voice: "en", rate_wpm: 999 }, never);
    expect(fast).toMatchObject({ reason: "clamped", clamped: true, measured: { voice: "en", rate_wpm: 300 } });
    expect(brick.spoken("espeak.args")!.split("\n").slice(0, 4)).toEqual(["-v", "en", "-s", "300"]);
  });

  speechTest("aborting the call cuts the audio and answers preempted; the speaker is free again", async () => {
    const { provider, brick } = setup();
    brick.setSpeech({ seconds: 3 });
    const ctl = new AbortController();
    const t0 = Date.now();
    const pending = provider.command("ev3.speaker", "speak", { text: "a long story" }, ctl.signal);
    expect(await until(() => brick.spoken("aplay.audio") !== null, 2000)).toBe(true);
    ctl.abort();
    const r = await pending;
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r).toMatchObject({ reason: "preempted", measured: { spoken: false } });
    expect(brick.spoken("aplay.done")).toBeNull(); // the playback never reached its end
    brick.setSpeech({ seconds: 0.05 });
    expect((await provider.command("ev3.speaker", "speak", { text: "again" }, never)).reason).toBe("completed");
    expect(brick.spoken("espeak.args")!.split("\n").at(-1)).toBe("again");
  });

  speechTest("one phrase at a time (busy), and stop cuts it", async () => {
    const { provider, brick } = setup();
    brick.setSpeech({ seconds: 3 });
    const first = provider.command("ev3.speaker", "speak", { text: "first" }, never);
    expect(await until(() => brick.spoken("aplay.audio") !== null, 2000)).toBe(true);
    expect(await code(provider.command("ev3.speaker", "speak", { text: "second" }, never))).toBe("busy");
    const t0 = Date.now();
    expect(await provider.stop()).toEqual({ motors_stopped: true });
    expect(await first).toMatchObject({ reason: "preempted", measured: { spoken: false } });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(brick.spoken("aplay.done")).toBeNull();
  });

  speechTest("bad arguments and a failing synthesizer are typed errors, never a silent success", async () => {
    const { provider, brick } = setup();
    const say = (args: Record<string, string | number>) => code(provider.command("ev3.speaker", "speak", args, never));
    expect(await say({})).toBe("invalid_argument");
    expect(await say({ text: " \n " })).toBe("invalid_argument");
    expect(await say({ text: "x".repeat(201) })).toBe("invalid_argument");
    expect(await say({ text: "hola", voice: "klingon" })).toBe("invalid_argument");
    expect(await say({ text: "hola", volume: 100 })).toBe("invalid_argument");
    expect(brick.spoken("espeak.args")).toBeNull(); // nothing was started
    brick.setSpeech({ espeakExit: 1 });
    let thrown: unknown;
    await provider.command("ev3.speaker", "speak", { text: "hola" }, never).catch((e) => (thrown = e));
    expect((thrown as RuntimeError).code).toBe("internal");
    expect((thrown as RuntimeError).message).toContain("`espeak` exited with 1: stub: cannot synthesize");
  });

  speechTest("a brick without espeak answers unknown_command to speak", async () => {
    const { provider } = setup("none");
    expect(await code(provider.command("ev3.speaker", "speak", { text: "hola" }, never))).toBe("unknown_command");
  });

  speechTest("brick watchdog: 1 s of silence cuts the speech", async () => {
    const brick = new FakeBrick({ motors: [], sensors: [], speech: { voices: VOICES } });
    brick.setSpeech({ seconds: 4 });
    const transport = brick.transport(python!);
    open.push({ brick, transport });
    const lines: Record<string, unknown>[] = [];
    transport.onLine((l) => lines.push(JSON.parse(l) as Record<string, unknown>));
    await transport.open();
    const bounds = { max_speed_pct: 60, max_op_ms: 250, low_battery_v: 6.5, max_tone_ms: 1000, speech_volume_pct: 50 };
    transport.send(JSON.stringify({ op: "hello", id: 1, config: { bounds, pair: { left: "B", right: "C" } } }));
    expect(await until(() => lines.some((l) => l.id === 1), 5000)).toBe(true);
    transport.send(JSON.stringify({ op: "command", id: 2, device: "speaker", command: "speak", args: { text: "x" } }));
    // nothing is sent from here on
    expect(await until(() => lines.some((l) => l.id === 2), BRICK_WATCHDOG_MS + 1500)).toBe(true);
    expect(lines.find((l) => l.id === 2)).toMatchObject({ ok: false, code: "robot_offline" });
    expect(brick.spoken("aplay.done")).toBeNull();
  });

  speechTest("closing the link cuts the speech", async () => {
    const { provider, brick } = setup();
    brick.setSpeech({ seconds: 0.8 });
    const pending = code(provider.command("ev3.speaker", "speak", { text: "bye" }, never));
    expect(await until(() => brick.spoken("aplay.audio") !== null, 2000)).toBe(true);
    await provider.close();
    expect(await pending).toBe("robot_offline");
    await sleep(1100);
    expect(brick.spoken("aplay.done")).toBeNull();
  });

  speechTest("a phrase that outlasts the cap is cut and reported as timeout", () => {
    const brick = new FakeBrick({ motors: [], sensors: [], speech: { voices: VOICES } });
    open.push({ brick });
    brick.setSpeech({ seconds: 3 });
    const r = spawnSync(pythonPath(python!), [join(import.meta.dir, "speak_cap_check.py"), BRIDGE_FILE, brick.root], {
      encoding: "utf8",
      env: { ...process.env, ...brick.env() },
    });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      still_talking: false,
      reply: [
        {
          id: 2,
          ok: true,
          result: {
            reason: "timeout",
            clamped: false,
            ms: expect.any(Number),
            measured: { voice: "es-la", rate_wpm: 140, chars: 13, spoken: false, time_limited: true },
          },
        },
      ],
    });
  });
});

describe("config", () => {
  test("speech_volume_pct is required and 1..100", () => {
    const dead: LineTransport = { open: async () => {}, send() {}, onLine() {}, onClose() {}, close: async () => {} };
    const limits = { max_speed_pct: 60, max_command_ms: 15000 };
    for (const hardware of [
      { low_battery_v: 6.5, max_tone_ms: 5000 },
      { ...EXAMPLE_EV3DEV_HARDWARE, speech_volume_pct: 0 },
      { ...EXAMPLE_EV3DEV_HARDWARE, speech_volume_pct: 101 },
    ]) {
      let thrown: unknown;
      try {
        void new Ev3devProvider(dead, { limits, hardware } as never).id;
      } catch (e) {
        thrown = e;
      }
      expect((thrown as RuntimeError)?.code).toBe("misconfigured");
    }
    expect(EXAMPLE_EV3DEV_HARDWARE).toEqual({ low_battery_v: 6.5, max_tone_ms: 5000, speech_volume_pct: 100 });
  });
});
