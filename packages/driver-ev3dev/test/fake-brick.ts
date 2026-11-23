// A fake ev3dev brick for tests: a directory tree shaped like the brick's /sys and /dev, and the
// real bridge (bridge/ev3dev_bridge.py) run by the local Python against it with --root.
// The tree is plain files: a test plays the kernel by writing `state`, `position` or `value0`.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_FILE, ProcessLineTransport } from "../src/ssh";

/** The local Python 3 command, or null. Probed by running it: on Windows `python3` can be a store stub. */
export function findPython(): string | null {
  for (const cmd of ["python3", "python"]) {
    const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0 && r.stdout.trim() === "3") return cmd;
  }
  return null;
}

/** Absolute path of that Python, so it starts even when the bridge is given a PATH of its own. */
export function pythonPath(python: string): string {
  const r = spawnSync(python, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`cannot ask ${python} for its own path: ${r.stderr}`);
  return r.stdout.trim();
}

/** The speech stubs are /bin/sh scripts, which Windows cannot run as programs: no fake speech there. */
export const FAKE_HAS_SPEECH = process.platform !== "win32";
// Stand-ins for the brick's espeak and aplay. They record how they were called in files next to them:
// espeak.args (one argument per line), aplay.args, aplay.audio (what was piped in), aplay.done (written only
// when "playback" reached its end). espeak.exit makes espeak fail; aplay.seconds is how long playback lasts.
const ESPEAK_STUB = `#!/bin/sh
dir="\${0%/*}"
if [ "$1" = "--voices" ]; then /bin/cat "$dir/voices.txt"; exit 0; fi
: > "$dir/espeak.args"
for a in "$@"; do printf '%s\\n' "$a" >> "$dir/espeak.args"; done
if [ -f "$dir/espeak.exit" ]; then echo "stub: cannot synthesize" >&2; exit "$(/bin/cat "$dir/espeak.exit")"; fi
printf 'RIFFfake'
`;
const APLAY_STUB = `#!/bin/sh
dir="\${0%/*}"
printf '%s\\n' "$@" > "$dir/aplay.args"
/bin/cat > "$dir/aplay.audio"
/bin/sleep "$(/bin/cat "$dir/aplay.seconds")"
echo done > "$dir/aplay.done"
`;

export interface FakeMotor {
  port: "A" | "B" | "C" | "D";
  driver?: string;
}
export interface FakeSensor {
  port: 1 | 2 | 3 | 4;
  driver: string;
  mode: string;
  modes: string[];
  values: number[];
  decimals?: number;
  /** The `units` attribute of the current mode; absent = the driver writes none. */
  units?: string;
  /** The `commands` attribute (a calibration, a reset); absent = the driver has none. */
  commands?: string[];
}
/** LED directory names contain ":", which Windows file systems reject, so the fake has no LEDs there. */
export const FAKE_HAS_LEDS = process.platform !== "win32";

/** Windows refuses to replace a file while another process has it open; the bridge's reads last microseconds. */
const SHARING = ["EPERM", "EACCES", "EBUSY"];
const REPLACE_TRIES = 2000;

export class FakeBrick {
  readonly root: string;
  private writes = 0;
  /** Where the speech stubs and their records live (only with `speech`). */
  readonly bin: string;
  private readonly path: string | undefined;
  /**
   * `speech`: undefined = the bridge sees this computer's PATH (whatever is installed here);
   * `{voices}` = the bridge's PATH holds only a stub espeak (offering those voices) and a stub aplay;
   * `"none"` = the bridge's PATH is an empty folder, so the brick has neither.
   */
  constructor(o: {
    motors: FakeMotor[];
    sensors: FakeSensor[];
    battery_uv?: number;
    speech?: { voices: string[] } | "none";
  }) {
    this.root = mkdtempSync(join(tmpdir(), "ev3dev-fake-"));
    mkdirSync(join(this.root, "tmp"));
    this.bin = join(this.root, "bin");
    if (o.speech !== undefined) {
      mkdirSync(this.bin);
      this.path = this.bin;
    }
    if (o.speech !== undefined && o.speech !== "none") {
      const rows = o.speech.voices.map((v) => ` 5  ${v.padEnd(14)} M  voice-${v}  lang/${v}`);
      writeFileSync(
        join(this.bin, "voices.txt"),
        ["Pty Language Age/Gender VoiceName          File          Other Languages", ...rows, ""].join("\n"),
      );
      writeFileSync(join(this.bin, "aplay.seconds"), "0.05\n");
      for (const [name, body] of [
        ["espeak", ESPEAK_STUB],
        ["aplay", APLAY_STUB],
      ] as const) {
        writeFileSync(join(this.bin, name), body);
        chmodSync(join(this.bin, name), 0o755);
      }
    }
    for (const cls of ["tacho-motor", "lego-sensor", "lego-port", "power_supply", "leds"])
      mkdirSync(join(this.root, "sys", "class", cls), { recursive: true });
    o.motors.forEach((m, i) => {
      const d = this.motorDir(i);
      mkdirSync(d);
      const files: Record<string, string> = {
        address: `ev3-ports:out${m.port}`,
        driver_name: m.driver ?? "lego-ev3-l-motor",
        position: "0",
        count_per_rot: "360",
        max_speed: "1050",
        speed: "0",
        speed_sp: "0",
        position_sp: "0",
        time_sp: "0",
        duty_cycle_sp: "0",
        duty_cycle: "0",
        stop_action: "coast",
        command: "",
        state: "",
        commands: "run-forever run-to-abs-pos run-to-rel-pos run-timed run-direct stop reset",
        stop_actions: "coast brake hold",
      };
      for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), `${v}\n`);
    });
    o.sensors.forEach((s, i) => {
      const d = join(this.root, "sys", "class", "lego-sensor", `sensor${i}`);
      mkdirSync(d);
      const files: Record<string, string> = {
        address: `ev3-ports:in${s.port}`,
        driver_name: s.driver,
        mode: s.mode,
        modes: s.modes.join(" "),
        decimals: String(s.decimals ?? 0),
        num_values: String(s.values.length),
        ...(s.units === undefined ? {} : { units: s.units }),
        ...(s.commands === undefined ? {} : { commands: s.commands.join(" "), command: "" }),
      };
      s.values.forEach((v, n) => {
        files[`value${n}`] = String(v);
      });
      for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), `${v}\n`);
    });
    if (o.battery_uv !== undefined) {
      const d = join(this.root, "sys", "class", "power_supply", "lego-ev3-battery");
      mkdirSync(d);
      writeFileSync(join(d, "voltage_now"), `${o.battery_uv}\n`);
    }
    if (FAKE_HAS_LEDS) {
      for (const side of [0, 1])
        for (const color of ["red", "green"]) {
          const d = join(this.root, "sys", "class", "leds", `led${side}:${color}:brick-status`);
          mkdirSync(d);
          for (const f of ["brightness", "trigger", "delay_on", "delay_off"]) writeFileSync(join(d, f), "0\n");
        }
    }
    mkdirSync(join(this.root, "dev", "input", "by-path"), { recursive: true });
    this.setButtons([]);
  }

  /**
   * Replaces an attribute file in one step (write a temporary file, rename it over the attribute), as the kernel
   * does: a reader sees the old value or the new one, never an empty or half-written file. Writing in place
   * truncates first, and the bridge, which polls these files from another process, then reads "".
   */
  private put(file: string, data: string | Uint8Array): void {
    const tmp = join(this.root, "tmp", `w${this.writes++}`);
    writeFileSync(tmp, data);
    for (let i = 1; ; i++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (e) {
        if (i >= REPLACE_TRIES || !SHARING.includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
        Bun.sleepSync(1);
      }
    }
  }

  /**
   * Rewrites an attribute in place, as the kernel does for a file a loop holds open: one write of a fixed-width
   * line at offset 0 of the same file, so a reader through a held descriptor sees the old value or the new one.
   * (put() replaces the file, which a held descriptor never sees.)
   */
  setInPlace(file: string, value: string | number): void {
    const fd = openSync(file, "r+");
    try {
      writeSync(fd, `${String(value).padStart(15)}\n`, 0);
    } finally {
      closeSync(fd);
    }
  }
  setMotorInPlace(i: number, attr: string, value: string | number): void {
    this.setInPlace(join(this.motorDir(i), attr), value);
  }
  setSensorInPlace(i: number, attr: string, value: string | number): void {
    this.setInPlace(join(this.root, "sys", "class", "lego-sensor", `sensor${i}`, attr), value);
  }
  /**
   * The first line of a motor attribute: what a driver reads of a value written through a held descriptor, which
   * writes its line at offset 0 and leaves any longer old text behind it in a plain file.
   */
  motorLine(i: number, attr: string): string {
    return readFileSync(join(this.motorDir(i), attr), "utf8")
      .split("\n")[0]!
      .trim();
  }

  motorDir(i: number): string {
    return join(this.root, "sys", "class", "tacho-motor", `motor${i}`);
  }
  motor(i: number, attr: string): string {
    return readFileSync(join(this.motorDir(i), attr), "utf8").trim();
  }
  setMotor(i: number, attr: string, value: string | number): void {
    this.put(join(this.motorDir(i), attr), `${value}\n`);
  }
  sensor(i: number, attr: string): string {
    return readFileSync(join(this.root, "sys", "class", "lego-sensor", `sensor${i}`, attr), "utf8").trim();
  }
  setSensor(i: number, attr: string, value: string | number): void {
    this.put(join(this.root, "sys", "class", "lego-sensor", `sensor${i}`, attr), `${value}\n`);
  }
  led(side: 0 | 1, color: "red" | "green", attr: string): string {
    return readFileSync(
      join(this.root, "sys", "class", "leds", `led${side}:${color}:brick-status`, attr),
      "utf8",
    ).trim();
  }
  /** Writes the key bitmap the kernel's EVIOCGKEY ioctl would return. */
  setButtons(codes: number[]): void {
    const bitmap = new Uint8Array(96);
    for (const c of codes) bitmap[c >> 3] |= 1 << (c & 7);
    this.put(join(this.root, "dev", "input", "by-path", "platform-gpio_keys-event"), bitmap);
  }

  /**
   * Plays the kernel motor driver for motor `i`: when the bridge writes a run command, the motor
   * "runs" for `ms` and lands on its target, or travels `timedDegrees` (timed). With stop_action
   * coast it rolls `coastOvershoot` degrees past the target. As on a real brick, run-to-abs-pos aims
   * at position_sp and run-to-rel-pos aims at the PREVIOUS target + position_sp, not at the current
   * position + position_sp. Returns a function that stops playing.
   */
  playMotor(i: number, ms = 40, timedDegrees = 50, coastOvershoot = 0): () => void {
    let busy = false;
    let lastTarget = Number(this.motor(i, "position"));
    const timer = setInterval(() => {
      if (busy) return;
      let cmd: string;
      try {
        cmd = this.motor(i, "command"); // "" while the bridge is mid-write: no run command yet
      } catch {
        return;
      }
      if (cmd !== "run-to-rel-pos" && cmd !== "run-to-abs-pos" && cmd !== "run-timed") return;
      busy = true;
      this.setMotor(i, "state", "running");
      const at = Number(this.motor(i, "position"));
      const sp = Number(this.motor(i, "position_sp"));
      const target =
        cmd === "run-timed"
          ? at + timedDegrees * Math.sign(Number(this.motor(i, "speed_sp")))
          : cmd === "run-to-abs-pos"
            ? sp
            : lastTarget + sp;
      lastTarget = target;
      const over = this.motor(i, "stop_action") === "coast" ? coastOvershoot * Math.sign(target - at) : 0;
      setTimeout(() => {
        this.setMotor(i, "position", target + over);
        this.setMotor(i, "command", `done:${cmd}`);
        this.setMotor(i, "state", "");
        busy = false;
      }, ms);
    }, 3);
    return () => clearInterval(timer);
  }

  /** A record a speech stub left, trimmed, or null when it did not write it. */
  spoken(file: "espeak.args" | "aplay.args" | "aplay.audio" | "aplay.done"): string | null {
    const f = join(this.bin, file);
    return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
  }
  /** How long the stub aplay "plays", and whether the stub espeak fails. */
  setSpeech(o: { seconds?: number; espeakExit?: number }): void {
    if (o.seconds !== undefined) writeFileSync(join(this.bin, "aplay.seconds"), `${o.seconds}\n`);
    if (o.espeakExit !== undefined) writeFileSync(join(this.bin, "espeak.exit"), `${o.espeakExit}\n`);
  }
  /** Environment for a process that plays the brick: the PATH this fake decided on, if any. */
  env(): Record<string, string> {
    return { PYTHONDONTWRITEBYTECODE: "1", ...(this.path === undefined ? {} : { PATH: this.path }) };
  }

  /** The real bridge, run locally against this tree. */
  transport(python: string): ProcessLineTransport {
    // With a PATH of its own the bridge's Python must be named by its full path.
    const cmd = this.path === undefined ? python : pythonPath(python);
    return new ProcessLineTransport(cmd, ["-u", BRIDGE_FILE, "--root", this.root], {
      label: "fake brick",
      env: this.env(),
    });
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
