// A fake ev3dev brick for tests: a directory tree shaped like the brick's /sys and /dev, and the
// real bridge (bridge/ev3dev_bridge.py) run by the local Python against it with --root.
// The tree is plain files: a test plays the kernel by writing `state`, `position` or `value0`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
}
/** LED directory names contain ":", which Windows file systems reject, so the fake has no LEDs there. */
export const FAKE_HAS_LEDS = process.platform !== "win32";

export class FakeBrick {
  readonly root: string;
  constructor(o: { motors: FakeMotor[]; sensors: FakeSensor[]; battery_uv?: number }) {
    this.root = mkdtempSync(join(tmpdir(), "ev3dev-fake-"));
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

  motorDir(i: number): string {
    return join(this.root, "sys", "class", "tacho-motor", `motor${i}`);
  }
  motor(i: number, attr: string): string {
    return readFileSync(join(this.motorDir(i), attr), "utf8").trim();
  }
  setMotor(i: number, attr: string, value: string | number): void {
    writeFileSync(join(this.motorDir(i), attr), `${value}\n`);
  }
  sensor(i: number, attr: string): string {
    return readFileSync(join(this.root, "sys", "class", "lego-sensor", `sensor${i}`, attr), "utf8").trim();
  }
  setSensor(i: number, attr: string, value: string | number): void {
    writeFileSync(join(this.root, "sys", "class", "lego-sensor", `sensor${i}`, attr), `${value}\n`);
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
    writeFileSync(join(this.root, "dev", "input", "by-path", "platform-gpio_keys-event"), bitmap);
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
        cmd = this.motor(i, "command");
      } catch {
        return;
      } // the bridge is mid-write
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

  /** The real bridge, run locally against this tree. */
  transport(python: string): ProcessLineTransport {
    return new ProcessLineTransport(python, ["-u", BRIDGE_FILE, "--root", this.root], {
      label: "fake brick",
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    });
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
