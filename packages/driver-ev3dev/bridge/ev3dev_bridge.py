#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""On-brick bridge for an ev3dev LEGO EV3: JSON lines on stdin, JSON lines on stdout.

Runs on the brick's Python 3.5 (ev3dev-stretch) with the standard library only and talks to
the kernel drivers through sysfs. No f-strings, no dataclasses, no asyncio.

Requests (one JSON object per line; every reply echoes "id"):
  {"op":"hello","id":1,"config":{"bounds":{"max_speed_pct":..,"max_op_ms":..,"low_battery_v":..,"max_tone_ms":..,
                                           "speech_volume_pct":..},
                                 "pair":{"left":"B","right":"C"},"ir_channel":1}}
                                       "pair" is optional: without it there is no "pair" device.
                                       "ir_channel" (1-4) is optional: the remote channel the infrared
                                       sensors read; without it, channel 1.
  {"op":"read","id":2,"device":"S4","channels":["proximity_pct"],"allow_mode_switch":false}
  {"op":"read_many","id":5,"reads":[{"device":"B"},{"device":"S4","channels":["proximity_pct"]}]}
                                       several reads, one answer: {"results":[<what each read alone answers>]}.
                                       It never switches a sensor mode.
  {"op":"command","id":3,"device":"B","command":"run_degrees","args":{"degrees":90,"speed_pct":30}}
  {"op":"abort","target":3}            no reply; command 3 answers with reason "preempted"
  {"op":"stop","id":4}                 brakes every motor, verifies, answers motors_stopped
  {"op":"hb"}                          answers {"ev":"hb"}
  {"op":"loop_start","id":6,"plan":{<a LoopPlan, devices by local name>}}
                                       starts a loop (CONTRACT 5a) as a task of this process and answers at
                                       once; then {"ev":"loop","loop":6,...} after 20 ticks and every 0.5 s, and
                                       {"ev":"loop_end","loop":6,"reason":..} at its end. abort with target 6
                                       ends it with reason preempted, as stop does.
  {"op":"loop_set","id":7,"loop":6,"params":{"k":1},"ramp_ms":0}
                                       changes params between two ticks; answers with the params as set
  {"op":"loop_probe","id":8,"plan":{..},"ticks":1000}
                                       runs that many ticks of the plan back to back with every output
                                       written as 0 and no run command; answers with what a tick costs
Replies: {"id":n,"ok":true,...} or {"id":n,"ok":false,"code":<contract ErrorCode>,"message":...}.
Events:  {"ev":"hb"}, {"ev":"watchdog","cause":"silence"}, {"ev":"loop",..}, {"ev":"loop_end",..}.

Safety rules of this file:
  * Motion uses run-to-abs-pos, run-timed and run-direct; run-forever is never written.
    run-direct (motor.power, and a loop's power output) has no time limit in the kernel: it is written
    only while the guard's deadman is armed (below). This process ends it at the operation's time and
    at a loop's end, and sets its power to 0 when hold_ms pass after a loop's latest refresh.
    The kernel driver ends run-timed by itself after time_sp, and run-to-abs-pos when the motor
    arrives: a motor that cannot arrive (a blocked wheel) keeps pushing until something writes
    stop, because the kernel has no time limit for a position move. That something is this
    process (the time cap of the operation, the watchdog) and, when this process is killed, the
    guard below. A degree move is always sent as an absolute
    target = the position read at the start of the operation + the delta. run-to-rel-pos is
    not used: on a real brick it counts from the previous target, not from where the motor
    is, so a relative move sent after a coasting overshoot runs backward.
  * One command is one operation, limited by time here on the brick: hello's max_op_ms of
    motion, never above MAX_OP_MS. The watchdog covers a dead link during a long operation. A degree move that has not arrived by then is braked and reported as it stands.
  * A read never writes. A channel that needs another sensor mode answers
    "mode_switch_required" unless the request names it and sets allow_mode_switch.
  * Watchdog: when no line arrives for WATCHDOG_MS, or stdin closes, or the process gets a
    termination signal, every tacho motor gets stop_action=brake and command=stop. The stop is
    written before anything else is done about it.
  * Guard: main() starts a second, tiny Python process that holds the read end of a pipe from
    this one. When this process ends in any way (SIGKILL and the kernel's out-of-memory killer
    included) the pipe closes, and the guard writes stop_action=brake and command=stop to every
    tacho motor, then exits. It does nothing else and reads nothing but that pipe. hello says
    whether it is running ("guard", "guard_pid"). The main loop looks at the guard on every
    pass: when the guard is gone while this process lives, this process brakes every motor and
    ends ({"ev":"guard_lost"}), so no robot is driven without one and the computer has to open a
    link again, which starts a bridge with a guard. The deadman: while run-direct is live on any
    motor, every pass of the main loop writes one byte to the guard; GUARD_DEADMAN_MS without one
    (a bridge that hangs, is stopped, or is starved) and the guard brakes every motor. Not covered:
    a brick whose kernel or power fails, and a bridge that hangs while no run-direct is live (the
    watchdog runs in this main loop; run-timed and run-to-abs-pos are bounded by the kernel and by
    the motor's arrival).
  * A loop (loop_start) is one task of the main loop, which goes on serving requests, the watchdog
    and the guard between two ticks. Its inputs and outputs are sysfs attributes held open for the
    life of the loop. Every end of a loop brakes every motor it drives before anything else; the
    watchdog ends it with reason timeout. The law is the port of packages/protocol/loop.ts below
    (law_start, law_step, law_set), held equal to it by packages/protocol/loop-golden.json.
  * The main loop never blocks: stdin and stdout live in their own threads, waits are tasks.
    It wakes at least every TICK_S for the watchdog and the touch sensors. A running motor is
    looked at when that can change something: at once after its command, then at half the time
    its target still needs, down to MOTION_TICK_S on arrival and never rarer than TICK_S.
  * Speech (speaker.speak, only when the brick has `espeak` and `aplay`) is two child processes
    started from argument lists, never through a shell. One phrase at a time, at most SPEAK_MAX_MS.
    abort, stop, the watchdog and the end of this process kill both, so the audio is cut.

Device names here are local ("B", "pair", "S4", "battery"); the provider adds its id prefix.
"""
import gc
import glob
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

try:
    import queue
except ImportError:  # pragma: no cover
    queue = None
try:
    import fcntl
except ImportError:  # Windows (tests against a fake tree)
    fcntl = None

# Exit codes of this process. Fixed, so the computer can tell why the bridge ended without reading text.
EXIT_OK = 0              # stdin closed or a signal: the link was closed
EXIT_CRASH = 1           # an unexpected error
EXIT_USAGE = 2           # bad arguments, or not an ev3dev brick
EXIT_GUARD_LOST = 3      # the guard process ended: every motor was braked and the bridge ended itself
VERSION = "7"            # sent in hello as "bridge"; the provider refuses a bridge older than the one it needs
# The guard's deadman: while it is armed, this long without a byte from the bridge brakes every motor.
GUARD_DEADMAN_MS = 200
# The guard process (see the safety rules above). It reads only its stdin, a pipe from the bridge: "a" arms the
# deadman (and every later "a" feeds it), "d" disarms it. Armed and GUARD_DEADMAN_MS without a byte: it brakes
# every motor and disarms. The pipe closing (the bridge ended, however it ended): it brakes every motor and ends.
GUARD_SOURCE = """
import glob, os, select, sys
DEADMAN_S = GUARD_DEADMAN_S


def brake():
    for d in sorted(glob.glob(os.path.join(sys.argv[1], "sys", "class", "tacho-motor", "motor*"))):
        for attr, value in (("stop_action", "brake"), ("command", "stop")):
            try:
                fd = os.open(os.path.join(d, attr), os.O_WRONLY | os.O_TRUNC)   # an attribute that exists, never a new file
                os.write(fd, value.encode("ascii"))
                os.close(fd)
            except Exception:
                pass


armed = False
timed = True   # select works on this pipe (POSIX); without it only the pipe's end is watched
while True:
    ready = [0]
    if timed:
        try:
            ready = select.select([0], [], [], DEADMAN_S if armed else None)[0]
        except (OSError, ValueError):
            timed = False
    if not ready:
        brake()
        armed = False
        continue
    try:
        data = os.read(0, 512)
    except Exception:
        data = b""
    if not data:
        break
    armed = data[-1:] == b"a"
brake()
""".replace("GUARD_DEADMAN_S", repr(GUARD_DEADMAN_MS / 1000.0))
WATCHDOG_MS = 1000
MAX_OP_MS = 3000         # ceiling for the motion one command may cause; hello's max_op_ms can only lower it
TICK_S = 0.01
MOTION_TICK_S = 0.002    # shortest wait between two looks at a running motor
MODE_SWITCH_S = 0.1
STOP_VERIFY_S = 0.8
REACH_TOLERANCE_DEG = 3.0
MIN_SPEED_COUNTS = 10
SPEAK_MAX_MS = 15000     # longest phrase; the audio is cut there
SPEAK_MAX_CHARS = 200
SPEAK_RATE_WPM = (80, 300, 140)   # espeak -s: lowest, highest, default
VOICES_TIMEOUT_S = 5

BOUND_KEYS = ["max_speed_pct", "max_op_ms", "low_battery_v", "max_tone_ms", "speech_volume_pct"]
LED_PATTERNS = ["off", "green", "red", "orange", "green_flash", "red_flash", "orange_flash",
                "green_pulse", "red_pulse", "orange_pulse"]
LED_COLORS = {"off": (0, 0), "green": (0, 255), "red": (255, 0), "orange": (255, 128)}
# Linux input key codes of the brick buttons, in the contract's order.
BUTTON_KEYS = [("up", 103), ("enter", 28), ("down", 108), ("right", 106), ("left", 105), ("back", 14)]

# The sensor entries: driver_name -> (kind, ((channel, (mode, index, count, form, stride)), ...)), channels in the
# order a read lists them. A channel is the `count`
# values of `mode` from `index` + `stride` * (ir_channel - 1), decoded by `form` (see decode). `stride` is the number
# of values per remote channel (infrared only, else 0). Both `read` and the inventory in hello are built from this
# table. A lego-sensor whose driver has no entry is a generic sensor: kind "sensor", channels values and mode.
SENSORS = {
    "lego-ev3-touch": ("touch", (("pressed", ("TOUCH", 0, 1, "bool", 0)),)),
    "lego-ev3-color": ("color", (("reflected_pct", ("COL-REFLECT", 0, 1, "int", 0)),
                                 ("ambient_pct", ("COL-AMBIENT", 0, 1, "int", 0)),
                                 ("color", ("COL-COLOR", 0, 1, "int", 0)), ("rgb", ("RGB-RAW", 0, 3, "ints", 0)),)),
    "lego-ev3-us": ("ultrasonic", (("distance_cm", ("US-DIST-CM", 0, 1, "num", 0)),)),
    "lego-ev3-gyro": ("gyro", (("angle_deg", ("GYRO-ANG", 0, 1, "ccw", 0)), ("rate_deg_s", ("GYRO-RATE", 0, 1, "ccw", 0)),)),
    "lego-ev3-ir": ("infrared", (("proximity_pct", ("IR-PROX", 0, 1, "int", 0)),
                                 ("beacon_heading", ("IR-SEEK", 0, 2, "heading", 2)),
                                 ("beacon_distance_pct", ("IR-SEEK", 0, 2, "distance", 2)),
                                 ("remote_buttons", ("IR-REMOTE", 0, 1, "int", 1)),)),
    # NXT sensors (S2: ev3dev sensor_data)
    "lego-nxt-touch": ("touch", (("pressed", ("TOUCH", 0, 1, "bool", 0)),)),
    "lego-nxt-light": ("light", (("reflected_pct", ("REFLECT", 0, 1, "num", 0)), ("ambient_pct", ("AMBIENT", 0, 1, "num", 0)),)),
    "lego-nxt-sound": ("sound", (("sound_db_pct", ("DB", 0, 1, "num", 0)), ("sound_dba_pct", ("DBA", 0, 1, "num", 0)),)),
    "lego-nxt-us": ("ultrasonic", (("distance_cm", ("US-DIST-CM", 0, 1, "num", 0)),)),
    "lego-nxt-temp": ("temperature", (("temperature_c", ("NXT-TEMP-C", 0, 1, "num", 0)),)),
}
GENERIC = "sensor"
GENERIC_CHANNELS = ["values", "mode"]
IR_CHANNELS = (1, 2, 3, 4)
# Used only when the sensor has no `decimals` attribute.
DEFAULT_DECIMALS = {"US-DIST-CM": 1}


class BridgeError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


def now():
    return time.monotonic()


def read_attr(path):
    # One open, one read, one close on the file descriptor itself: a sysfs attribute is at most a page,
    # and Python's text layer costs more than the read (every look at a motor is three of these).
    fd = os.open(path, os.O_RDONLY)
    try:
        return os.read(fd, 4096).decode("utf-8").strip()
    finally:
        os.close(fd)


class SysfsValueError(BridgeError, ValueError):
    """A sysfs attribute that does not hold the number its driver documents.

    Never retried: on a brick it means a driver fault. It is a ValueError too, so a read that
    reports a failed value per channel (null plus the error) keeps doing so.
    """
    def __init__(self, path, raw, expected):
        BridgeError.__init__(self, "internal", "sysfs attribute %s reads %r, expected %s" % (path, raw, expected))


def read_int(path):
    raw = read_attr(path)
    try:
        return int(raw)
    except ValueError:
        raise SysfsValueError(path, raw, "an integer")


def read_float(path):
    raw = read_attr(path)
    try:
        return float(raw)
    except ValueError:
        raise SysfsValueError(path, raw, "a number")


def write_attr(path, value):
    with open(path, "w") as f:
        f.write(str(value))


def read_list(path):
    try:
        return read_attr(path).split()
    except (OSError, IOError):
        return None


def tidy(x):
    """Numbers for the wire: one decimal at most, integers stay integers."""
    r = round(float(x), 1)
    return int(r) if r == int(r) else r


def number(args, key, where):
    v = args.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        raise BridgeError("invalid_argument", "%s: %s must be a finite number, got %s" % (where, key, json.dumps(v)))
    return v


def cut(v, limit):
    if abs(v) > limit:
        return (limit if v > 0 else -limit), True
    return v, False


def next_look(timed_left_s, travel):
    """Seconds until a running operation is looked at again.

    A timed run: when its time is up. A degree move (`travel`: a (counts still to go, counts per second)
    pair per moving motor): half the time the farthest motor still needs at its commanded speed, so the
    looks get closer together toward the target, where the answer is due. Never rarer than TICK_S (the
    time cap and a blocked wheel are noticed within one tick) and never closer than MOTION_TICK_S (a look is
    three sysfs reads per motor on a slow processor).
    """
    if timed_left_s is not None:
        wait = timed_left_s
    else:
        wait = 0.0
        for left, speed in travel:
            if left > 0:
                wait = max(wait, left / float(speed) / 2.0)
    return max(MOTION_TICK_S, min(TICK_S, wait))


# ---------------------------------------------------------------- the law of a loop
# A port of packages/protocol/loop.ts (startLoop, setParams, stepLoop, recordTick), held equal to it by
# packages/protocol/loop-golden.json. Every number is a float from the start (Python ints do not round the way
# a double does), only + - * / in the order loop.ts writes them, and lists wherever an order matters.
LOOP_LOST_TICKS = 3
LOOP_STILL_NOISES = 4
LOOP_TRACE_POINTS = 200
LOOP_LATE_PERIODS = 10
LOOP_READING_MAX = 1e9
LOOP_STATE_MAX = 1e12
LOOP_MAX_MAGNITUDE = 1e6
LOOP_MAX_RAMP_MS = 3600000
LOOP_START_TICKS = 20     # the first telemetry: run_loop answers after these
LOOP_EVENT_S = 0.5        # then one telemetry line per this long
LOOP_LATE_IN_A_ROW = 3
LOOP_LATE_SHARE = 0.05


def law_number(x):
    """A plan's number as a float; refuses anything else (a plan is checked before it gets here)."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        raise BridgeError("invalid_argument", "loop plan: %s is not a number" % json.dumps(x))
    return float(x)


def law_reading(x):
    """-> the reading as a float, or None: a value only when an int or a float (never a bool), finite, within 1e9."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    try:
        x = float(x)
    except OverflowError:
        return None
    if x != x or x < -LOOP_READING_MAX or x > LOOP_READING_MAX:
        return None
    return x


def law_cut(x, lo, hi):
    return lo if x < lo else (hi if x > hi else x)


def law_held(x):
    return law_cut(x, -LOOP_STATE_MAX, LOOP_STATE_MAX)


def law_ref(x):
    """A setpoint, gain or feed: a float, or the name of a param (a str)."""
    if x is None or isinstance(x, str):
        return x
    return law_number(x)


def law_start(plan):
    """The state a loop starts in (loop.ts startLoop), from a plan as JSON."""
    signals = []
    names = {}
    for i, p in enumerate(plan["signals"]):
        names[p["name"]] = i
        signals.append({
            "name": p["name"], "zero": p["zero"], "mean_ms": law_number(p["mean_ms"]),
            "noise": law_number(p["noise"]), "detrend_s": law_number(p["detrend_s"]),
            "smooth_ms": law_number(p["smooth_ms"]),
            "seen": False, "missed": 0, "raw": 0.0, "offset": 0.0, "zeroed": p["zero"] != "mean",
            "m_t": 0.0, "m_n": 0, "m_sum": 0.0, "m_min": 0.0, "m_max": 0.0,
            "gap": 0.0, "trend": 0.0, "value": 0.0, "integral": 0.0, "derivative": 0.0,
        })
    outputs = []
    for o in plan["outputs"]:
        terms = []
        for t in o["terms"]:
            if "feed" in t:
                terms.append({"feed": law_ref(t["feed"]), "gain": law_ref(t.get("gain"))})
            else:
                if t["signal"] not in names:
                    raise BridgeError("invalid_argument", "loop plan: a term names no signal %s" % json.dumps(t["signal"]))
                clamp = t.get("clamp")
                terms.append({"signal": names[t["signal"]], "of": t.get("of", "value"),
                              "setpoint": law_ref(t.get("setpoint")), "gain": law_ref(t.get("gain")),
                              "clamp": None if clamp is None else law_number(clamp)})
        outputs.append({"min": law_number(o["min"]), "max": law_number(o["max"]), "terms": terms})
    guards = []
    for g in plan["guards"]:
        if g["signal"] not in names:
            raise BridgeError("invalid_argument", "loop plan: guard %s names no signal %s" % (json.dumps(g["name"]), json.dumps(g["signal"])))
        for_ms = g.get("for_ms")
        guards.append({"name": g["name"], "signal": names[g["signal"]], "of": g.get("of", "value"),
                       "op": g["op"], "value": law_number(g["value"]),
                       "for_ms": None if for_ms is None else law_number(for_ms)})
    params = {}
    for k in plan["params"]:
        params[k] = law_number(plan["params"][k])
    for o in outputs:
        for t in o["terms"]:
            for key in ("feed", "gain", "setpoint"):
                if isinstance(t.get(key), str) and t[key] not in params:
                    raise BridgeError("invalid_argument", "loop plan: a term names no param %s" % json.dumps(t[key]))
    return {
        "period_ms": law_number(plan["period_ms"]), "trace_hz": law_number(plan["trace_hz"]),
        "phase": "settling", "ticks": 0, "law_ticks": 0, "t_ms": 0.0,
        "params": params, "ramps": {}, "signals": signals, "outputs": outputs, "guards": guards,
        "integrals": [[0.0 for _ in o["terms"]] for o in outputs],
        "held": [-1.0 for _ in guards],
        "u": [0.0 for _ in outputs], "cut": [False for _ in outputs], "end": None,
    }


def law_set(st, params, ramp_ms):
    """Changes named params between two ticks, all at once (loop.ts setParams). Checks every one first."""
    if isinstance(ramp_ms, bool) or not isinstance(ramp_ms, (int, float)) or ramp_ms != ramp_ms or ramp_ms < 0 or ramp_ms > LOOP_MAX_RAMP_MS:
        raise BridgeError("invalid_argument", "ramp_ms: number from 0 to %d" % LOOP_MAX_RAMP_MS)
    if not isinstance(params, dict):
        raise BridgeError("invalid_argument", "params must be an object of numbers")
    for name in params:
        if name not in st["params"]:
            raise BridgeError("invalid_argument", "params.%s: no param \"%s\"; params: %s" % (name, name, ", ".join(sorted(st["params"])) or "none"))
        to = law_reading(params[name])
        if to is None or to < -LOOP_MAX_MAGNITUDE or to > LOOP_MAX_MAGNITUDE:
            raise BridgeError("invalid_argument", "params.%s: must be a number within 1e6 either way" % name)
    ramp_ms = float(ramp_ms)
    for name in params:
        to = float(params[name])
        if ramp_ms > 0:
            st["ramps"][name] = {"from": st["params"][name], "to": to, "ramp_ms": ramp_ms, "t_ms": 0.0}
        else:
            st["params"][name] = to
            st["ramps"].pop(name, None)


def law_num(st, x, absent):
    if x is None:
        return absent
    if isinstance(x, str):
        return st["params"][x]
    return x


def law_part(sig, of):
    if of == "integral":
        return sig["integral"]
    if of == "derivative":
        return sig["derivative"]
    return sig["value"]


def law_holds(g, x):
    if g["op"] == "gt":
        return x > g["value"]
    if g["op"] == "lt":
        return x < g["value"]
    return (-x if x < 0 else x) > g["value"]


def law_step(st, inputs, dt_ms):
    """One tick (loop.ts stepLoop): `inputs` holds one reading per signal of the plan, in its order (None = no
    value); `dt_ms` is the time since the previous tick, not read on the first. Changes `st` in place.
    -> (outputs, end): one value per output, all 0 while the loop settles and on the tick that ends it;
    end is None or {"reason": .., "guard"?: ..} on the tick that ends the loop."""
    n = len(st["outputs"])
    if st["phase"] == "ended":
        return [0.0] * n, st["end"]
    if isinstance(dt_ms, bool) or not isinstance(dt_ms, (int, float)) or dt_ms != dt_ms or dt_ms < 0 or dt_ms == float("inf"):
        raise BridgeError("invalid_argument", "dt_ms: number of at least 0")
    dt = 0.0 if st["ticks"] == 0 else float(dt_ms)
    st["ticks"] += 1
    st["t_ms"] = st["t_ms"] + dt
    ramps, st["ramps"] = st["ramps"], {}
    st["u"] = [0.0] * n
    st["cut"] = [False] * n

    def ended(end):
        st["phase"] = "ended"
        st["end"] = end
        st["u"] = [0.0] * n
        st["cut"] = [False] * n
        return [0.0] * n, end

    if dt > LOOP_LATE_PERIODS * st["period_ms"]:
        return ended({"reason": "overrun"})
    params = st["params"]
    for name in ramps:
        r = ramps[name]
        t = r["t_ms"] + dt
        if t >= r["ramp_ms"]:
            params[name] = r["to"]
        else:
            params[name] = r["from"] + ((r["to"] - r["from"]) * t) / r["ramp_ms"]
            st["ramps"][name] = {"from": r["from"], "to": r["to"], "ramp_ms": r["ramp_ms"], "t_ms": t}

    # readings, and the measurements of `zero`
    signals = st["signals"]
    fresh = []
    for i in range(len(signals)):
        sig = signals[i]
        x = law_reading(inputs[i]) if i < len(inputs) else None
        fresh.append(x is not None)
        if x is None:
            sig["missed"] += 1
            if sig["missed"] >= LOOP_LOST_TICKS:
                return ended({"reason": "input_lost"})
        else:
            sig["missed"] = 0
            sig["raw"] = x
            if not sig["seen"] and sig["zero"] == "start":
                sig["offset"] = x
        if sig["zeroed"]:
            if x is not None:
                sig["seen"] = True
            continue
        # zero mean: readings count from the signal's first one until mean_ms have passed
        if sig["seen"]:
            sig["m_t"] = sig["m_t"] + dt
        if sig["m_t"] < sig["mean_ms"]:
            if x is not None:
                sig["m_min"] = x if (sig["m_n"] == 0 or x < sig["m_min"]) else sig["m_min"]
                sig["m_max"] = x if (sig["m_n"] == 0 or x > sig["m_max"]) else sig["m_max"]
                sig["m_sum"] = sig["m_sum"] + x
                sig["m_n"] += 1
                sig["seen"] = True
        else:
            if sig["m_max"] - sig["m_min"] > LOOP_STILL_NOISES * sig["noise"]:
                return ended({"reason": "not_still"})
            sig["offset"] = sig["m_sum"] / sig["m_n"]
            sig["zeroed"] = True
    for sig in signals:
        if not (sig["seen"] and sig["zeroed"]):
            return [0.0] * n, None

    # signals: zero, detrend, smooth, then the derivative and the integral of the value
    first = st["phase"] == "settling"
    st["phase"] = "running"
    st["law_ticks"] += 1
    for i in range(len(signals)):
        sig = signals[i]
        v = sig["raw"] - sig["offset"]
        if first:
            if sig["detrend_s"] > 0:
                sig["trend"] = v
                v = 0.0
            sig["value"] = v
            sig["gap"] = 0.0
            continue
        sig["gap"] = sig["gap"] + dt
        if fresh[i]:
            gap = sig["gap"]
            if sig["detrend_s"] > 0:
                sig["trend"] = sig["trend"] + ((v - sig["trend"]) * gap) / (sig["detrend_s"] * 1000 + gap)
                v = v - sig["trend"]
            if sig["smooth_ms"] > 0:
                v = sig["value"] + ((v - sig["value"]) * gap) / (sig["smooth_ms"] + gap)
            if gap > 0:
                sig["derivative"] = law_held(((v - sig["value"]) * 1000) / gap)
            sig["value"] = v
            sig["gap"] = 0.0
        sig["integral"] = law_held(sig["integral"] + (sig["value"] * dt) / 1000)
    law_dt = 0.0 if first else dt

    # the law: every output is the sum of its terms, cut to its bounds
    out = [0.0] * n
    for i in range(n):
        o = st["outputs"][i]
        u = 0.0
        for j in range(len(o["terms"])):
            t = o["terms"][j]
            if "feed" in t:
                u = u + law_num(st, t["gain"], 1.0) * law_num(st, t["feed"], 0.0)
                continue
            sig = signals[t["signal"]]
            setpoint = law_num(st, t["setpoint"], 0.0)
            if t["of"] == "integral":
                acc = law_held(st["integrals"][i][j] + ((sig["value"] - setpoint) * law_dt) / 1000)
                if t["clamp"] is not None:
                    acc = law_cut(acc, -t["clamp"], t["clamp"])
                st["integrals"][i][j] = acc
                u = u + law_num(st, t["gain"], 0.0) * acc
            else:
                u = u + law_num(st, t["gain"], 0.0) * (law_part(sig, t["of"]) - setpoint)
        if u != u or u in (float("inf"), float("-inf")):
            raise BridgeError("internal", "loop output %d is not a finite number" % i)
        st["cut"][i] = u < o["min"] or u > o["max"]
        out[i] = law_cut(u, o["min"], o["max"])
    st["u"] = out

    # guards, in their order: the first that holds long enough ends the loop on this tick
    for i in range(len(st["guards"])):
        g = st["guards"][i]
        if not law_holds(g, law_part(signals[g["signal"]], g["of"])):
            st["held"][i] = -1.0
            continue
        st["held"][i] = 0.0 if st["held"][i] < 0 else st["held"][i] + law_dt
        if g["for_ms"] is None or st["held"][i] >= g["for_ms"]:
            return ended({"reason": "guard", "guard": g["name"]})
    return list(out), None


def stats_start(st):
    """What a report says of the ticks since the previous telemetry line (loop.ts startStats), as raw windows:
    the computer merges them, so they keep counts and sums rather than means."""
    return {
        "signals": [{"n": 0, "min": 0.0, "max": 0.0, "sum": 0.0, "last": 0.0, "integral": 0.0, "derivative": 0.0}
                    for _ in st["signals"]],
        "outputs": [{"n": 0, "min": 0.0, "max": 0.0, "sum": 0.0, "last": 0.0, "cut": 0} for _ in st["outputs"]],
        "trace": stats_trace(st), "next_trace_ms": 0.0,
    }


def stats_trace(st):
    trace = {"t_ms": []}
    for s in st["signals"]:
        trace[s["name"]] = []
    for i in range(len(st["outputs"])):
        trace["out%d" % i] = []
    return trace


def stats_add(w, x, weight):
    w["min"] = x if (w["n"] == 0 or x < w["min"]) else w["min"]
    w["max"] = x if (w["n"] == 0 or x > w["max"]) else w["max"]
    w["sum"] = w["sum"] + weight
    w["n"] += 1


def stats_record(stats, st):
    """Takes in the tick that produced `st`, once per tick (loop.ts recordTick)."""
    if st["law_ticks"] == 0:
        return
    for i, sig in enumerate(st["signals"]):
        w = stats["signals"][i]
        stats_add(w, sig["value"], sig["value"])
        w["last"] = sig["value"]
        w["integral"] = sig["integral"]
        w["derivative"] = sig["derivative"]
    for i, u in enumerate(st["u"]):
        w = stats["outputs"][i]
        stats_add(w, u, -u if u < 0 else u)
        w["last"] = u
        if st["cut"][i]:
            w["cut"] += 1
    if st["t_ms"] < stats["next_trace_ms"] and st["phase"] != "ended":
        return
    every = 1000 / st["trace_hz"]
    while stats["next_trace_ms"] <= st["t_ms"]:
        stats["next_trace_ms"] = stats["next_trace_ms"] + every
    trace = stats["trace"]
    trace["t_ms"].append(st["t_ms"])
    for sig in st["signals"]:
        trace[sig["name"]].append(sig["value"])
    for i, u in enumerate(st["u"]):
        trace["out%d" % i].append(u)
    if len(trace["t_ms"]) > LOOP_TRACE_POINTS:
        for key in trace:
            trace[key].pop(0)


def stats_take(stats, st):
    """The windows and the trace since the previous call, and fresh ones. Counters keep their latest values."""
    out = {"signals": stats["signals"], "outputs": stats["outputs"], "trace": stats["trace"]}
    stats["signals"] = [{"n": 0, "min": 0.0, "max": 0.0, "sum": 0.0, "last": w["last"], "integral": w["integral"],
                         "derivative": w["derivative"]} for w in out["signals"]]
    stats["outputs"] = [{"n": 0, "min": 0.0, "max": 0.0, "sum": 0.0, "last": w["last"], "cut": 0} for w in out["outputs"]]
    stats["trace"] = stats_trace(st)
    return out


def held_open(path, write):
    """An attribute held open for the life of a loop: one pread or pwrite per tick, no open and close."""
    return os.open(path, os.O_WRONLY if write else os.O_RDONLY)


def held_read(fd):
    """The attribute's first line. sysfs builds the text again on every read at offset 0."""
    if hasattr(os, "pread"):
        raw = os.pread(fd, 64, 0)
    else:  # pragma: no cover (Windows has no pread; the bridge runs on Linux)
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, 64)
    return raw.decode("ascii", "replace").split("\n")[0].strip()


def held_write(fd, text):
    """One write of `text` and a newline at offset 0: the driver parses it at once (kstrtoint takes the newline)."""
    data = (text + "\n").encode("ascii")
    if hasattr(os, "pwrite"):
        os.pwrite(fd, data, 0)
    else:  # pragma: no cover
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, data)


def round_half(x):
    """Rounds half away from zero, as the computer's Math.round does for the values a loop writes."""
    return int(math.floor(x + 0.5)) if x >= 0 else -int(math.floor(-x + 0.5))


# What a loop probe declares: the fastest of these rates whose p99 tick takes at most half a period (the other
# half is the scheduler's pass, requests served between ticks and the telemetry line).
PROBE_RATES = (10, 20, 25, 50, 100, 200)
PROBE_MAX_TICKS = 20000


class LoopRun(object):
    """A loop being run, or probed: its plan, its law, and the attributes it holds open."""
    def __init__(self, rid, plan):
        self.id = rid
        self.plan = plan
        self.st = law_start(plan)
        self.stats = stats_start(self.st)
        self.period_s = law_number(plan["period_ms"]) / 1000.0
        self.duration_ms = law_number(plan["duration_ms"])
        self.readers = []      # one function per signal: -> float or None
        self.outputs = []      # one dict per output: {motor, command, hold_s, fds, ...}
        self.motors = []       # the motors the loop drives, in the plan's order
        self.fds = []          # every attribute held open, closed at the end
        self.task = None
        self.ticks = 0
        self.overruns = 0
        self.periods = []      # measured time between two ticks since the previous telemetry, ms
        self.recent = []       # (time, late) of the ticks of the last second
        self.late_row = 0
        self.first = None
        self.last_at = None
        self.sent = 0.0        # when the latest telemetry line left
        self.ended = False


class Motor(object):
    def __init__(self, directory, port):
        self.dir = directory
        self.port = port
        self.address = read_attr(os.path.join(directory, "address"))
        self.driver = read_attr(os.path.join(directory, "driver_name"))
        self.cpr = read_int(os.path.join(directory, "count_per_rot"))
        self.max_speed = read_int(os.path.join(directory, "max_speed"))
        self.commands = read_list(os.path.join(directory, "commands"))
        self.stop_actions = read_list(os.path.join(directory, "stop_actions"))
        self.owner = None      # id of the command running on this motor
        self.stalled = False   # the last command ended because the motor could not turn

    def get(self, name):
        return read_attr(os.path.join(self.dir, name))

    def get_int(self, name):
        return read_int(os.path.join(self.dir, name))

    def set(self, name, value):
        write_attr(os.path.join(self.dir, name), value)

    def counts(self):
        return self.get_int("position")

    def deg(self, counts):
        return counts * 360.0 / self.cpr

    def to_counts(self, degrees):
        return int(round(degrees * self.cpr / 360.0))

    def state(self):
        return self.get("state").split()

    def brake(self):
        brake_now(self.dir)

    def info(self):
        return {"port": self.port, "address": self.address, "driver_name": self.driver,
                "count_per_rot": self.cpr, "max_speed": self.max_speed,
                "commands": self.commands, "stop_actions": self.stop_actions}


class Sensor(object):
    def __init__(self, directory, port):
        self.dir = directory
        self.port = port
        self.address = read_attr(os.path.join(directory, "address"))
        self.driver = read_attr(os.path.join(directory, "driver_name"))
        entry = SENSORS.get(self.driver)
        self.kind = entry[0] if entry is not None else GENERIC
        self.order = [c[0] for c in entry[1]] if entry is not None else []
        self.channels = dict(entry[1]) if entry is not None else {}
        self.modes = read_list(os.path.join(directory, "modes"))
        # the commands the driver takes (a calibration, a reset); only a generic sensor sends them
        self.commands = read_list(os.path.join(directory, "commands")) if entry is None else None
        self.decimals = {}     # mode -> its `decimals` attribute, once read
        self.mode_seen = None  # the mode the read in progress found this sensor in (None: read it again)
        self.presses = 0       # touch only: bumps counted by this process
        self.was_pressed = False

    def get(self, name):
        return read_attr(os.path.join(self.dir, name))

    def get_int(self, name):
        return read_int(os.path.join(self.dir, name))

    def get_float(self, name):
        return read_float(os.path.join(self.dir, name))

    def set(self, name, value):
        write_attr(os.path.join(self.dir, name), value)

    def info(self):
        mode = None
        try:
            mode = self.get("mode")
        except (OSError, IOError):
            pass
        out = {"port": self.port, "address": self.address, "driver_name": self.driver,
               "kind": self.kind, "mode": mode, "modes": self.modes,
               "channel_modes": dict((c, self.channels[c][0]) for c in self.channels)}
        if self.kind == GENERIC:
            out.update(self.describe())
            out["commands"] = self.commands
        return out

    def describe(self):
        """What the driver says of the current mode: its number of values and their unit (generic sensors)."""
        out = {"num_values": None, "units": None}
        try:
            out["num_values"] = self.get_int("num_values")
        except (OSError, IOError, ValueError):
            pass
        try:
            out["units"] = self.get("units") or None
        except (OSError, IOError):
            pass
        return out


def start_guard(root):
    """Starts the guard process. Its stdin is a pipe only this process holds: it closes when this process ends."""
    if not sys.executable:
        raise OSError("this Python does not know its own executable, so a second one cannot be started")
    extra = {}
    if os.name == "posix":
        extra["start_new_session"] = True   # a signal sent to this process's group does not reach the guard
    return subprocess.Popen([sys.executable, "-S", "-c", GUARD_SOURCE, root], stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **extra)


def brake_now(motor_dir):
    """stop_action=brake then command=stop. The stop is written even if the first write fails."""
    err = None
    try:
        write_attr(os.path.join(motor_dir, "stop_action"), "brake")
    except (OSError, IOError) as e:
        err = e
    write_attr(os.path.join(motor_dir, "command"), "stop")
    if err is not None:
        raise err


class Task(object):
    def __init__(self, rid, gen, motors=None):
        self.id = rid
        self.gen = gen
        self.due = 0.0
        self.flag = None       # "preempted" | "watchdog"
        self.motors = motors or []
        self.talk = None       # the speech this task waits for: {"espeak": Popen, "aplay": Popen}


class Bridge(object):
    def __init__(self, root):
        self.root = root
        self.inq = queue.Queue()
        self.outq = queue.Queue()
        self.last_rx = [now()]     # stamped by the reader thread when a line arrives
        self.writer_dead = [False]
        self.wd_tripped = False
        self.bounds = None
        self.op_ms = MAX_OP_MS
        self.pair = None
        self.ir_channel = 1
        self.motors = {}
        self.sensors = {}
        self.ignored = []
        self.tasks = []
        self.beeps = []
        self.speech = None         # hello: {"espeak", "aplay", "voices", "default_voice"} when the brick can speak
        self.talk = None           # the phrase being spoken now
        self.last_touch = 0.0
        self.battery = None        # path of the battery's voltage_now, once found
        self.sink = None           # read_many: the answers of its reads are collected here instead of sent
        self.guard = None          # main(): the guard process
        self.no_guard = "the bridge was not started through main()"
        self.exit_code = EXIT_OK   # what main() returns after run()
        self.speech_found = None   # find_speech()'s answer, looked up once per process
        self.loop = None           # the running loop (LoopRun), or None
        self.direct = {}           # port -> id of the operation that has run-direct live on it
        self.duty = {}             # port -> the duty cycle run-direct applies there now (power_pct)
        self.guard_armed = False   # the guard's deadman is armed (the last byte sent was "a")
        self.guard_fed = 0.0       # when the guard last got a byte of an armed deadman
        self.deadman_lapsed = False  # an armed deadman went unfed long enough that the guard may have braked

    # ------------------------------------------------------------ paths

    def p(self, *parts):
        return os.path.join(self.root, *parts)

    def motor_dirs(self):
        return sorted(glob.glob(self.p("sys", "class", "tacho-motor", "motor*")))

    def battery_path(self):
        found = sorted(glob.glob(self.p("sys", "class", "power_supply", "*", "voltage_now")))
        return found[0] if found else None

    def led_path(self, side, color, attr):
        return self.p("sys", "class", "leds", "led%d:%s:brick-status" % (side, color), attr)

    def buttons_path(self):
        return self.p("dev", "input", "by-path", "platform-gpio_keys-event")

    # ------------------------------------------------------------ io threads

    def reader(self):
        stream = sys.stdin.buffer
        while True:
            try:
                line = stream.readline()
            except Exception:
                line = b""
            if not line:
                self.inq.put(None)
                return
            self.last_rx[0] = now()
            self.inq.put(line)

    def writer(self):
        stream = sys.stdout.buffer
        while True:
            item = self.outq.get()
            try:
                stream.write(item)
                stream.flush()
            except Exception:
                self.writer_dead[0] = True
                return

    def send(self, obj):
        if self.sink is not None:
            self.sink.append(obj)
            return
        self.outq.put((json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8"))

    def ok(self, rid, extra):
        out = {"id": rid, "ok": True}
        out.update(extra)
        self.send(out)

    def fail(self, rid, code, message):
        self.send({"id": rid, "ok": False, "code": code, "message": message})

    # ------------------------------------------------------------ safety

    def stop_all_now(self):
        """Brakes every tacho motor found right now. Returns the list of write errors."""
        errors = []
        for d in self.motor_dirs():
            try:
                brake_now(d)
            except (OSError, IOError) as e:
                errors.append("%s: %s" % (d, e))
        return errors

    def hush(self):
        """Cuts the phrase being spoken, if any: kills aplay (it holds the buffered audio), then espeak."""
        talk, self.talk = self.talk, None
        if talk is None:
            return
        for name in ("aplay", "espeak"):
            try:
                talk[name].kill()
            except (OSError, IOError):
                pass                             # it had already ended
        for name in ("aplay", "espeak"):
            try:
                talk[name].wait()
            except (OSError, IOError):
                pass
            talk[name].stderr.close()

    def watchdog(self):
        if self.wd_tripped:
            return
        if (now() - self.last_rx[0]) * 1000.0 <= WATCHDOG_MS:
            return
        self.stop_all_now()                      # first, before any bookkeeping or output
        self.hush()
        self.wd_tripped = True
        for t in self.tasks:
            if (t.motors or t.talk) and t.flag is None:
                t.flag = "watchdog"
                t.due = 0.0
        self.send({"ev": "watchdog", "cause": "silence", "watchdog_ms": WATCHDOG_MS})

    # ------------------------------------------------------------ inventory

    def scan(self):
        old_motors, old_sensors = self.motors, self.sensors
        motors, sensors, ignored = {}, {}, []
        for d in self.motor_dirs():
            try:
                address = read_attr(os.path.join(d, "address"))
                m = re.search(r"out([A-D])$", address)
                if not m:
                    ignored.append({"local": os.path.basename(d), "class": "tacho-motor", "address": address,
                                    "driver_name": read_attr(os.path.join(d, "driver_name")), "modes": None})
                    continue
                prev = old_motors.get(m.group(1))
                # The same motor keeps its object: a running operation holds it and releases it by identity.
                motors[m.group(1)] = prev if prev is not None and prev.dir == d else Motor(d, m.group(1))
            except (OSError, IOError, ValueError) as e:
                ignored.append({"local": os.path.basename(d), "class": "tacho-motor", "address": None, "driver_name": None, "modes": None, "error": str(e)})
        for d in sorted(glob.glob(self.p("sys", "class", "lego-sensor", "sensor*"))):
            try:
                address = read_attr(os.path.join(d, "address"))
                driver = read_attr(os.path.join(d, "driver_name"))
                m = re.search(r"in([1-4])$", address)
                if not m:
                    ignored.append({"local": ("S" + m.group(1)) if m else os.path.basename(d), "class": "lego-sensor",
                                    "address": address, "driver_name": driver, "modes": read_list(os.path.join(d, "modes"))})
                    continue
                s = Sensor(d, int(m.group(1)))
                prev = old_sensors.get(s.port)
                if prev is not None and prev.dir == d and prev.driver == s.driver:
                    s.presses, s.was_pressed = prev.presses, prev.was_pressed
                sensors[s.port] = s
            except (OSError, IOError, ValueError) as e:
                ignored.append({"local": os.path.basename(d), "class": "lego-sensor", "address": None, "driver_name": None, "modes": None, "error": str(e)})
        self.motors, self.sensors, self.ignored = motors, sensors, ignored

    def hello(self, rid, msg):
        config = msg.get("config")
        if not isinstance(config, dict) or not isinstance(config.get("bounds"), dict):
            raise BridgeError("misconfigured", "hello needs config.bounds with: " + ", ".join(BOUND_KEYS))
        b = config["bounds"]
        for k in BOUND_KEYS:
            v = b.get(k)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not v > 0:
                raise BridgeError("misconfigured", "config.bounds.%s is required and must be a number > 0, got %s" % (k, json.dumps(v)))
        if b["max_speed_pct"] > 100:
            raise BridgeError("misconfigured", "config.bounds.max_speed_pct must be <= 100")
        if b["speech_volume_pct"] > 100:
            raise BridgeError("misconfigured", "config.bounds.speech_volume_pct must be <= 100")
        pair = config.get("pair")
        if pair is not None:
            left, right = (pair.get("left"), pair.get("right")) if isinstance(pair, dict) else (None, None)
            if left not in list("ABCD") or right not in list("ABCD") or left == right:
                raise BridgeError("misconfigured", "config.pair, when given, needs two different ports A-D as left and right")
            pair = (left, right)
        ir = config.get("ir_channel", 1)
        if isinstance(ir, bool) or ir not in IR_CHANNELS:
            raise BridgeError("misconfigured", "config.ir_channel, when given, must be 1, 2, 3 or 4, got %s" % json.dumps(ir))
        self.ir_channel = ir
        self.bounds = dict((k, b[k]) for k in BOUND_KEYS)
        self.op_ms = int(max(1, min(MAX_OP_MS, b["max_op_ms"])))   # never above MAX_OP_MS, whatever the config says
        self.pair = pair                                           # None: this robot has no motor pair
        self.battery = None
        self.scan()
        if self.speech_found is None:
            self.speech_found = self.find_speech()   # `espeak --voices` blocks this loop: once per process
        self.speech, no_speech = self.speech_found
        ports = []
        for d in sorted(glob.glob(self.p("sys", "class", "lego-port", "port*"))):
            try:
                ports.append({"address": read_attr(os.path.join(d, "address")), "status": read_attr(os.path.join(d, "status"))})
            except (OSError, IOError):
                pass
        leds = all(os.path.exists(self.led_path(side, color, "brightness")) for side in (0, 1) for color in ("red", "green"))
        self.ok(rid, {
            "bridge": VERSION,
            "guard": self.guard is not None and self.guard.poll() is None,
            "guard_pid": self.guard.pid if self.guard is not None and self.guard.poll() is None else None,
            "no_guard": None if self.guard is not None and self.guard.poll() is None else self.no_guard,
            "python": "%d.%d.%d" % tuple(sys.version_info[:3]),
            "watchdog_ms": WATCHDOG_MS,
            "ir_channel": self.ir_channel,
            "motors": [self.motors[k].info() for k in sorted(self.motors)],
            "sensors": [self.sensors[k].info() for k in sorted(self.sensors)],
            "ports": ports,
            "unknown": self.ignored,
            "max_op_ms": self.op_ms,
            "stop_verify_ms": int(STOP_VERIFY_S * 1000),
            "capabilities": {
                "battery": self.battery_path() is not None,
                "led": leds,
                "buttons": os.path.exists(self.buttons_path()),
                "beep": shutil.which("beep") is not None,
                "display": False,
                "speak": self.speech is not None,
            },
            # Not null only when the brick can speak; the provider builds speaker.speak from it.
            "speech": None if self.speech is None else {
                "voices": self.speech["voices"], "default_voice": self.speech["default_voice"],
                "max_ms": SPEAK_MAX_MS, "max_chars": SPEAK_MAX_CHARS,
                "rate_wpm": {"min": SPEAK_RATE_WPM[0], "max": SPEAK_RATE_WPM[1], "default": SPEAK_RATE_WPM[2]},
            },
            "no_speech": no_speech,
        })

    def find_speech(self):
        """-> (speech or None, why not). Speech needs `espeak`, `aplay` and at least one voice."""
        espeak, aplay = shutil.which("espeak"), shutil.which("aplay")
        if espeak is None or aplay is None:
            lacking = [n for n, found in (("espeak", espeak), ("aplay", aplay)) if found is None]
            return None, "no `%s` program on its PATH" % "` or `".join(lacking)
        try:
            out = subprocess.check_output([espeak, "--voices"], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                          timeout=VOICES_TIMEOUT_S)
        except (OSError, IOError, subprocess.SubprocessError) as e:
            return None, "`espeak --voices` failed: %s" % e
        voices = []
        # Columns: Pty Language Age/Gender VoiceName File Other-Languages. The Language column is what -v takes.
        for line in out.decode("utf-8", "replace").splitlines()[1:]:
            cols = line.split()
            if len(cols) >= 4 and re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]*$", cols[1]) and cols[1] not in voices:
                voices.append(cols[1])
        if not voices:
            return None, "`espeak --voices` lists no voice"
        default = "es-la" if "es-la" in voices else "en" if "en" in voices else voices[0]
        return {"espeak": espeak, "aplay": aplay, "voices": voices, "default_voice": default}, None

    def need_hello(self):
        if self.bounds is None:
            raise BridgeError("misconfigured", "send hello with config.bounds before any other request")

    def has_pair(self):
        return self.pair is not None and self.pair[0] in self.motors and self.pair[1] in self.motors

    def find(self, device):
        """-> (kind, object or None)"""
        if device in self.motors:
            return "motor", self.motors[device]
        if device == "pair":
            if self.has_pair():
                return "motor_pair", None
        elif isinstance(device, str) and re.match(r"^S[1-4]$", device) and int(device[1]) in self.sensors:
            s = self.sensors[int(device[1])]
            return s.kind, s
        elif device in ("speaker", "display", "led", "buttons", "battery"):
            return device, None
        names = sorted(self.motors) + (["pair"] if self.has_pair() else [])
        names += ["S%d" % k for k in sorted(self.sensors)] + ["speaker", "display", "led", "buttons", "battery"]
        raise BridgeError("unknown_device", "unknown device %s; devices: %s" % (json.dumps(device), ", ".join(names)))

    # ------------------------------------------------------------ read

    def read(self, rid, msg):
        self.need_hello()
        kind, obj = self.find(msg.get("device"))
        asked = msg.get("channels")
        if kind == "motor":
            known = ["position_deg", "speed_deg_s", "stalled", "power_pct"]
        elif kind == "motor_pair":
            known = ["left_deg", "right_deg"]
        elif kind == "battery":
            known = ["voltage_v", "low"]
        elif kind == "buttons":
            known = ["pressed"]
        elif obj is not None and kind == GENERIC:
            known = GENERIC_CHANNELS
        elif obj is not None:
            known = obj.order + (["presses"] if kind == "touch" else [])
        else:
            known = []
        names = known if asked is None else asked
        if not isinstance(names, list):
            raise BridgeError("invalid_argument", "channels must be a list of channel names")
        for n in names:
            if n not in known:
                raise BridgeError("unknown_channel", "device %s has no channel %s; channels: %s" % (msg.get("device"), json.dumps(n), ", ".join(known) or "none"))
        if obj is not None and kind != "motor":
            switch = msg.get("allow_mode_switch") is True and asked is not None
            self.spawn(Task(rid, self.read_sensor(rid, obj, names, switch)))
            return
        values = {}
        try:
            if kind == "motor":
                values["position_deg"] = (tidy(obj.deg(obj.counts())), None)
                values["speed_deg_s"] = (tidy(obj.deg(obj.get_int("speed"))), None)
                values["stalled"] = (bool(obj.stalled), None)
                values["power_pct"] = (self.duty.get(obj.port, 0), None)
            elif kind == "motor_pair":
                l, r = self.motors[self.pair[0]], self.motors[self.pair[1]]
                values["left_deg"] = (tidy(l.deg(l.counts())), None)
                values["right_deg"] = (tidy(r.deg(r.counts())), None)
            elif kind == "battery":
                if self.battery is None:
                    self.battery = self.battery_path()
                path = self.battery
                if path is None:
                    raise IOError("no power_supply with voltage_now")
                volts = read_int(path) / 1000000.0
                values["voltage_v"] = (round(volts, 2), None)
                values["low"] = (volts < self.bounds["low_battery_v"], None)
            elif kind == "buttons":
                values["pressed"] = (self.buttons_pressed(), None)
        except (OSError, IOError, ValueError) as e:
            for n in names:
                values[n] = (None, "internal: %s" % e)
        self.reply_readings(rid, names, values)

    def read_many(self, rid, msg):
        """Several reads, one answer line. Each read is answered as `read` answers it alone, errors included,
        so a device that cannot be read does not take the others with it. No read here may switch a mode."""
        self.need_hello()
        reads = msg.get("reads")
        if not isinstance(reads, list):
            raise BridgeError("invalid_argument", "read_many needs reads: a list of {device, channels}")
        results = []
        for item in reads:
            box = []
            self.sink = box
            try:
                try:
                    if not isinstance(item, dict):
                        raise BridgeError("invalid_argument", "each read is an object {device, channels}")
                    self.read(None, {"device": item.get("device"), "channels": item.get("channels")})
                except BridgeError as e:
                    box.append({"ok": False, "code": e.code, "message": e.message})
                except (OSError, IOError) as e:
                    box.append({"ok": False, "code": "internal", "message": "sysfs: %s" % e})
            finally:
                self.sink = None
            if len(box) != 1:
                # A read without a mode switch answers before it returns; anything else is a fault of this file.
                self.tasks = [t for t in self.tasks if t.id is not None or t.motors or t.talk]
                raise BridgeError("internal", "read of %s inside read_many gave %d answers, expected 1" % (json.dumps(item), len(box)))
            box[0].pop("id", None)
            results.append(box[0])
        self.ok(rid, {"results": results})

    def reply_readings(self, rid, names, values, extra=None):
        out = []
        for n in names:
            value, error = values[n][0], values[n][1]
            item = {"channel": n, "value": value}
            if value is None:
                item["error"] = error or "no value"
                if len(values[n]) > 2 and values[n][2] is True:
                    item["absent"] = True
            out.append(item)
        reply = {"readings": out}
        if extra:
            reply.update(extra)
        self.ok(rid, reply)

    def buttons_pressed(self):
        path = self.buttons_path()
        size = 96  # KEY_MAX / 8 + 1
        if fcntl is not None and not os.path.isfile(path):
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
            try:
                # EVIOCGKEY(size) = _IOR('E', 0x18, size)
                bitmap = fcntl.ioctl(fd, (2 << 30) | (size << 16) | (0x45 << 8) | 0x18, b"\0" * size)
            finally:
                os.close(fd)
        else:
            # A regular file (a fake tree in tests) holds the same key bitmap the ioctl returns.
            with open(path, "rb") as f:
                bitmap = f.read(size)
        bitmap = bytearray(bitmap)
        held = []
        for name, code in BUTTON_KEYS:
            if code // 8 < len(bitmap) and bitmap[code // 8] & (1 << (code % 8)):
                held.append(name)
        return held

    def decode(self, sensor, channel, vals):
        """-> (value, error[, absent]) of one channel from the values of its mode, by the form its entry names."""
        mode, index, count, form, stride = sensor.channels[channel]
        at = index + stride * (self.ir_channel - 1)
        mine = vals[at:at + count]
        if form == "bool":
            return (mine[0] >= 0.5, None)
        if form == "ccw":
            r = int(round(mine[0]))
            return (0 if r == 0 else -r, None)   # native clockwise-positive -> contract counter-clockwise-positive
        if form == "ints":
            return ([int(round(v)) for v in mine], None)
        if form == "num":
            return (tidy(mine[0]), None)
        if form in ("heading", "distance"):
            if mine[1] < 0 or mine[1] > 100:
                # the sensor's answer, not a failed read: sent with "absent": true
                return (None, "no beacon in view on channel %d" % self.ir_channel, True)
            if form == "distance":
                return (int(round(mine[1])), None)
            h = int(round(mine[0]))
            return (0 if h == 0 else -h, None)   # native negative = left -> contract counter-clockwise-positive
        return (int(round(mine[0])), None)

    def fetch_count(self, sensor, channel):
        """How many values of its mode a channel needs read: up to its last one on this robot's ir_channel."""
        mode, index, count, form, stride = sensor.channels[channel]
        return index + stride * (self.ir_channel - 1) + count

    def sensor_values(self, sensor, mode, count, switch):
        """Generator: leaves the values of `mode` in self.got. Writes the mode only when `switch` is true."""
        if sensor.modes is not None and mode not in sensor.modes:
            raise BridgeError("unsupported", "sensor %s has no mode %s; it offers: %s" % (sensor.driver, mode, " ".join(sensor.modes)))
        sensor.mode_seen = sensor.get("mode")
        if sensor.mode_seen != mode:
            if not switch:
                raise BridgeError("mode_switch_required", "mode_switch_required")
            sensor.set("mode", mode)
            yield MODE_SWITCH_S
            # After a switch the mode is read again, not assumed. Cleared here, after the wait: other
            # requests were handled meanwhile, and nothing they saw may pass for what this read found.
            sensor.mode_seen = None
        decimals = sensor.decimals.get(mode)
        if decimals is None:
            try:
                # Fixed by the driver for each mode: read once per sensor and mode.
                decimals = sensor.decimals[mode] = sensor.get_int("decimals")
            except (OSError, IOError, ValueError):
                decimals = DEFAULT_DECIMALS.get(mode, 0)
        scale = float(10 ** decimals)
        self.got = [sensor.get_float("value%d" % i) / scale for i in range(count)]

    def read_generic(self, rid, sensor, names):
        """values and mode of a sensor without an entry: what the driver reports in its current mode, never a switch."""
        values = {}
        extra = sensor.describe()
        mode = None
        try:
            mode = sensor.get("mode")
        except (OSError, IOError) as e:
            for n in names:
                values[n] = (None, "sensor on port %d returned no mode (unplugged?): %s" % (sensor.port, e))
        if mode is not None:
            extra["mode"] = mode
            values["mode"] = (mode, None)
            if "values" in names:
                try:
                    if extra["num_values"] is None:
                        raise IOError("no num_values attribute")
                    for delay in self.sensor_values(sensor, mode, extra["num_values"], False):
                        yield delay
                    values["values"] = ([tidy(v) for v in self.got], None)
                except (OSError, IOError, ValueError) as e:
                    values["values"] = (None, "sensor on port %d returned no value (unplugged?): %s" % (sensor.port, e))
                except BridgeError as e:
                    values["values"] = (None, "%s: %s" % (e.code, e.message))
        self.reply_readings(rid, names, values, extra)

    def read_sensor(self, rid, sensor, names, switch):
        if sensor.kind == GENERIC:
            for delay in self.read_generic(rid, sensor, names):
                yield delay
            return
        values = {}
        sensor.mode_seen = None
        for n in names:
            if n in values:
                continue
            if sensor.kind == "touch" and n == "presses":
                values[n] = (sensor.presses, None)
                continue
            mode = sensor.channels[n][0]
            same = [m for m in names if m in sensor.channels and sensor.channels[m][0] == mode]
            count = max(self.fetch_count(sensor, m) for m in same)
            try:
                for delay in self.sensor_values(sensor, mode, count, switch):
                    yield delay
                vals = self.got
                for m in same:
                    values[m] = self.decode(sensor, m, vals)
            except (OSError, IOError, ValueError) as e:   # first: SysfsValueError is a BridgeError too
                for m in same:
                    values[m] = (None, "sensor on port %d returned no value (unplugged?): %s" % (sensor.port, e))
            except BridgeError as e:
                for m in same:
                    values[m] = (None, e.message if e.code == "mode_switch_required" else "%s: %s" % (e.code, e.message))
        # The mode this read found the sensor in. Read here only if nothing above did, or a switch was written.
        mode = sensor.mode_seen
        if mode is None:
            try:
                mode = sensor.get("mode")
            except (OSError, IOError):
                pass
        self.reply_readings(rid, names, values, {"mode": mode})

    def sample_touch(self):
        for s in self.sensors.values():
            if s.kind != "touch":
                continue
            try:
                pressed = s.get_float("value0") >= 0.5
            except (OSError, IOError, ValueError):
                continue
            if s.was_pressed and not pressed:
                s.presses += 1
            s.was_pressed = pressed

    # ------------------------------------------------------------ commands

    def speed(self, args, where):
        raw = number(args, "speed_pct", where)
        if raw <= 0:
            raise BridgeError("invalid_argument", "%s: speed_pct must be > 0 (direction comes from the sign of the degrees), got %s" % (where, raw))
        top = self.bounds["max_speed_pct"]
        return max(1, min(top, int(round(raw)))), raw > top

    def brake_arg(self, args, where):
        v = args.get("brake", True)
        if not isinstance(v, bool):
            raise BridgeError("invalid_argument", "%s: brake must be true or false, got %s" % (where, json.dumps(v)))
        return v

    def done(self, rid, measured, clamped=False, reason="completed", t0=None, extra=None):
        out = {"result": {"measured": measured, "clamped": clamped, "reason": reason,
                          "ms": 0 if t0 is None else int(round((now() - t0) * 1000))}}
        if extra:
            out.update(extra)
        self.ok(rid, out)

    def command(self, rid, msg):
        self.need_hello()
        device, command, args = msg.get("device"), msg.get("command"), msg.get("args")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise BridgeError("invalid_argument", "args must be an object")
        kind, obj = self.find(device)
        where = "%s.%s" % (device, command)
        b = self.bounds
        t0 = now()
        key = "%s.%s" % (kind, command)

        if key == "motor.run_degrees":
            deg = number(args, "degrees", where)
            pct, c2 = self.speed(args, where)
            brake = self.brake_arg(args, where)
            self.claim([obj])
            self.motion(rid, [{"motor": obj, "deg": deg, "pct": pct}], None, c2, {"applied_speed_pct": pct}, "single", brake)
        elif key == "motor.run_to_position":
            target = number(args, "position_deg", where)
            pct, c2 = self.speed(args, where)
            brake = self.brake_arg(args, where)
            self.claim([obj])
            deg = target - obj.deg(obj.counts())
            self.motion(rid, [{"motor": obj, "deg": deg, "pct": pct}], None, c2, {"applied_speed_pct": pct}, "absolute", brake)
        elif key == "motor.run_time":
            ms = number(args, "ms", where)
            if ms < 1:
                raise BridgeError("invalid_argument", "%s: ms must be >= 1, got %s" % (where, ms))
            ms, c1 = cut(int(round(ms)), self.op_ms)
            raw = number(args, "speed_pct", where)
            if raw == 0:
                raise BridgeError("invalid_argument", "%s: speed_pct must not be 0" % where)
            pct, c2 = cut((1 if raw > 0 else -1) * max(1, int(round(abs(raw)))), int(b["max_speed_pct"]))
            brake = self.brake_arg(args, where)
            self.claim([obj])
            self.motion(rid, [{"motor": obj, "pct": pct}], ms, c1 or c2,
                        {"applied_ms": ms, "applied_speed_pct": pct}, "single", brake)
        elif key == "motor.power":
            ms = number(args, "ms", where)
            if ms < 1:
                raise BridgeError("invalid_argument", "%s: ms must be >= 1, got %s" % (where, ms))
            ms, c1 = cut(int(round(ms)), self.op_ms)
            raw = number(args, "power_pct", where)
            if raw == 0:
                raise BridgeError("invalid_argument", "%s: power_pct must not be 0" % where)
            pct, c2 = cut((1 if raw > 0 else -1) * max(1, int(round(abs(raw)))), int(b["max_speed_pct"]))
            self.claim([obj])
            if obj.commands is not None and "run-direct" not in obj.commands:
                raise BridgeError("unsupported", "motor on port %s (%s) does not offer run-direct; it offers: %s" % (obj.port, obj.driver, " ".join(obj.commands)))
            task = Task(rid, None, [obj])
            task.gen = self.run_power(task, obj, pct, ms, c1 or c2, {"applied_ms": ms, "applied_power_pct": pct}, t0)
            obj.owner = rid
            self.spawn(task)
        elif key == "motor.brake" or key == "motor_pair.brake":
            which = [obj] if kind == "motor" else [self.motors[self.pair[0]], self.motors[self.pair[1]]]
            for m in which:
                m.brake()                        # first
            for t in self.tasks:
                if t.flag is None and any(m in t.motors for m in which):
                    t.flag = "preempted"
                    t.due = 0.0
            self.spawn(Task(rid, self.verify_brake(rid, which, t0)))
        elif key == "motor.reset_position":
            self.claim([obj])
            obj.set("position", 0)
            self.done(rid, {}, t0=t0)
        elif key == "motor_pair.run_pair":
            left, right = self.motors[self.pair[0]], self.motors[self.pair[1]]
            l, r = number(args, "left_deg", where), number(args, "right_deg", where)
            pct, clamped = self.speed(args, where)
            brake = self.brake_arg(args, where)
            big = max(abs(l), abs(r))
            self.claim([left, right])
            # Each wheel gets a speed proportional to its own travel, so both need the same time.
            moves = [{"motor": left, "deg": l, "pct": pct * abs(l) / float(big) if big else 0},
                     {"motor": right, "deg": r, "pct": pct * abs(r) / float(big) if big else 0}]
            self.motion(rid, moves, None, clamped, {"applied_speed_pct": pct}, "pair", brake)
        elif key == "gyro.reset":
            self.spawn(Task(rid, self.gyro_reset(rid, obj, t0)))
        elif key == "sensor.set_mode":
            mode = args.get("mode")
            if not isinstance(mode, str) or obj.modes is None or mode not in obj.modes:
                raise BridgeError("invalid_argument", "%s: mode must be one of %s, got %s" % (where, ", ".join(obj.modes or []), json.dumps(mode)))
            self.spawn(Task(rid, self.set_mode(rid, obj, mode, t0)))
        elif key == "sensor.send" and obj.commands:
            cmd = args.get("command")
            if not isinstance(cmd, str) or cmd not in obj.commands:
                raise BridgeError("invalid_argument", "%s: command must be one of %s, got %s" % (where, ", ".join(obj.commands), json.dumps(cmd)))
            obj.set("command", cmd)
            self.done(rid, {"command": cmd}, t0=t0)
        elif key == "speaker.tone" or key == "speaker.beep":
            if key == "speaker.beep":
                hz, ms = 1000, int(min(200, b["max_tone_ms"]))
                clamped = False
            else:
                asked_hz, asked_ms = int(round(number(args, "frequency_hz", where))), int(round(number(args, "duration_ms", where)))
                if asked_ms < 1:
                    raise BridgeError("invalid_argument", "%s: duration_ms must be >= 1, got %s" % (where, asked_ms))
                hz, ms = max(250, min(10000, asked_hz)), int(min(b["max_tone_ms"], asked_ms))
                clamped = hz != asked_hz or ms != asked_ms
            try:
                self.beeps.append(subprocess.Popen(["beep", "-f", str(hz), "-l", str(ms)],
                                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            except (OSError, IOError) as e:
                raise BridgeError("unsupported", "%s: cannot run the `beep` program on the brick: %s" % (where, e))
            self.done(rid, {"frequency_hz": hz, "duration_ms": ms}, clamped, "clamped" if clamped else "completed", t0)
        elif key == "speaker.speak" and self.speech is not None:
            self.speak(rid, args, where, t0)
        elif key == "display.text" or key == "display.clear":
            raise BridgeError("unsupported", "%s: the ev3dev bridge does not draw on the screen (the brick's own menu owns the framebuffer)" % where)
        elif key == "led.set":
            pattern = args.get("pattern")
            if pattern not in LED_PATTERNS:
                raise BridgeError("invalid_argument", "%s: pattern must be one of %s" % (where, ", ".join(LED_PATTERNS)))
            self.set_led(pattern)
            self.done(rid, {}, t0=t0)
        else:
            raise BridgeError("unknown_command", "device %s (%s) has no command %s" % (device, kind, json.dumps(command)))

    def speak(self, rid, args, where, t0):
        sp = self.speech
        text = args.get("text")
        if not isinstance(text, str):
            raise BridgeError("invalid_argument", "%s: text must be a string, got %s" % (where, json.dumps(text)))
        text = re.sub(r"[\x00-\x1f\x7f]+", " ", text).strip()
        if not text:
            raise BridgeError("invalid_argument", "%s: text is empty" % where)
        if len(text) > SPEAK_MAX_CHARS:
            raise BridgeError("invalid_argument", "%s: text has %d characters, at most %d fit in one phrase; split it" % (where, len(text), SPEAK_MAX_CHARS))
        voice = args.get("voice", sp["default_voice"])
        if voice not in sp["voices"]:
            raise BridgeError("invalid_argument", "%s: unknown voice %s; voices: %s" % (where, json.dumps(voice), ", ".join(sp["voices"])))
        lo, hi, usual = SPEAK_RATE_WPM
        asked = int(round(number(args, "rate_wpm", where))) if "rate_wpm" in args else usual
        rate = max(lo, min(hi, asked))
        clamped = rate != asked
        if self.talk is not None:
            raise BridgeError("busy", "%s: the speaker is still saying the previous phrase; wait for it or call stop" % where)
        amplitude = int(round(self.bounds["speech_volume_pct"] * 2))     # espeak -a is 0..200
        # Argument lists, no shell. "--" ends the options, so a text that starts with "-" stays text.
        argv = [sp["espeak"], "-v", voice, "-s", str(rate), "-a", str(amplitude), "--stdout", "--", text]
        try:
            espeak = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except (OSError, IOError) as e:
            raise BridgeError("unsupported", "%s: cannot run `espeak` on the brick: %s" % (where, e))
        try:
            aplay = subprocess.Popen([sp["aplay"], "-q"], stdin=espeak.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except (OSError, IOError) as e:
            espeak.kill()
            espeak.wait()
            espeak.stdout.close()
            espeak.stderr.close()
            raise BridgeError("unsupported", "%s: cannot run `aplay` on the brick: %s" % (where, e))
        espeak.stdout.close()                    # aplay holds the only read end now
        talk = {"espeak": espeak, "aplay": aplay}
        self.talk = talk
        task = Task(rid, None)
        task.talk = talk
        task.gen = self.speaking(task, where, {"voice": voice, "rate_wpm": rate, "chars": len(text)}, clamped, t0)
        self.spawn(task)

    def speaking(self, task, where, measured, clamped, t0):
        talk = task.talk
        deadline = t0 + SPEAK_MAX_MS / 1000.0
        reason = None
        while True:
            if task.flag:
                reason = task.flag
                break
            if talk["aplay"].poll() is not None and talk["espeak"].poll() is not None:
                break
            if now() >= deadline:
                reason = "timeout"
                break
            yield TICK_S
        if reason is None:
            failed = []
            for name in ("espeak", "aplay"):
                detail = talk[name].stderr.read().decode("utf-8", "replace").strip()[:300]
                talk[name].stderr.close()
                if talk[name].returncode != 0:
                    failed.append("`%s` exited with %s%s" % (name, talk[name].returncode, (": " + detail) if detail else ""))
            self.talk = None
            if failed:
                raise BridgeError("internal", "%s: nothing or only part of the text was spoken; %s" % (where, "; ".join(failed)))
            measured["spoken"] = True
            self.done(task.id, measured, clamped, "clamped" if clamped else "completed", t0)
            return
        if self.talk is talk:
            self.hush()                          # stop and the watchdog cut it themselves; abort and the cap cut it here
        if reason == "watchdog":
            self.fail(task.id, "robot_offline", "brick watchdog: no message for %d ms, the speech was cut" % WATCHDOG_MS)
            return
        measured["spoken"] = False
        if reason == "timeout":
            measured["time_limited"] = True
        self.done(task.id, measured, clamped, reason, t0)

    def set_led(self, pattern):
        parts = pattern.split("_")
        red, green = LED_COLORS[parts[0]]
        blink = None
        if len(parts) > 1:
            blink = (500, 500) if parts[1] == "flash" else (150, 850)
        for side in (0, 1):
            for color, level in (("red", red), ("green", green)):
                trigger = self.led_path(side, color, "trigger")
                if os.path.exists(trigger):
                    write_attr(trigger, "none")
                write_attr(self.led_path(side, color, "brightness"), level)
                if blink and level > 0:
                    if not os.path.exists(trigger):
                        raise BridgeError("unsupported", "led pattern %s needs the kernel LED timer trigger, which this brick does not expose" % pattern)
                    write_attr(trigger, "timer")
                    write_attr(self.led_path(side, color, "delay_on"), blink[0])
                    write_attr(self.led_path(side, color, "delay_off"), blink[1])

    def set_mode(self, rid, sensor, mode, t0):
        sensor.set("mode", mode)
        yield MODE_SWITCH_S
        extra = sensor.describe()
        extra["mode"] = sensor.get("mode")
        self.done(rid, {"mode": extra["mode"]}, t0=t0, extra=extra)

    def gyro_reset(self, rid, sensor, t0):
        # Leaving angle mode and coming back zeroes the angle (the sensor has no reset command).
        for mode in ("GYRO-RATE", "GYRO-ANG"):
            for delay in self.sensor_values(sensor, mode, 1, True):
                yield delay
        value = self.decode(sensor, "angle_deg", self.got)[0]
        self.done(rid, {"angle_deg": value}, t0=t0, extra={"mode": "GYRO-ANG"})

    def verify_brake(self, rid, motors, t0):
        """Answers once every one of `motors` reads speed 0 and is not running; stop_unverified otherwise."""
        deadline = now() + STOP_VERIFY_S
        while True:
            moving = []
            for m in motors:
                speed = m.get_int("speed")
                if "running" in m.state() or speed != 0:
                    moving.append("port %s speed=%d" % (m.port, speed))
            if not moving:
                break
            if now() > deadline:
                raise BridgeError("stop_unverified", "brake sent, but after %d ms: %s" % (int(STOP_VERIFY_S * 1000), "; ".join(moving)))
            yield TICK_S
        self.done(rid, {}, t0=t0)

    def claim(self, motors):
        for m in motors:
            if m.owner is not None:
                raise BridgeError("busy", "a command is already running on output port %s; wait for it or call stop" % m.port)

    def motion(self, rid, moves, timed_ms, clamped, applied, shape, brake):
        motors = [mv["motor"] for mv in moves]
        needed = "run-timed" if timed_ms is not None else "run-to-abs-pos"
        action = "brake" if brake else "coast"
        for m in motors:
            if m.commands is not None and needed not in m.commands:
                raise BridgeError("unsupported", "motor on port %s (%s) does not offer %s; it offers: %s" % (m.port, m.driver, needed, " ".join(m.commands)))
            if m.stop_actions is not None and action not in m.stop_actions:
                raise BridgeError("unsupported", "motor on port %s (%s) does not offer stop action %s; it offers: %s" % (m.port, m.driver, action, " ".join(m.stop_actions)))
        task = Task(rid, None, motors)
        task.gen = self.run_motion(task, moves, timed_ms, clamped, applied, shape, action)
        for m in motors:
            m.owner = rid
        self.spawn(task)

    def run_motion(self, task, moves, timed_ms, clamped, applied, shape, action):
        """One operation. It ends when the encoders say the move is done, or at the time cap."""
        motors = task.motors
        t0 = now()
        reason = None
        start = []
        try:
            start = [m.counts() for m in motors]
            targets = []   # counts each motor must travel, signed; None for timed runs
            expected = []  # degrees each motor should cover in this operation if nothing blocks it
            speeds = []    # counts per second each motor was told to turn at (0: it does not move)
            active = []
            absolute = []  # (index, motor, signed counts to travel) of degree moves
            for i, mv in enumerate(moves):
                m = mv["motor"]
                speed = int(round(abs(mv["pct"]) / 100.0 * m.max_speed))
                if timed_ms is not None:
                    speed = max(1, speed)
                    m.set("speed_sp", speed if mv["pct"] > 0 else -speed)
                    m.set("time_sp", int(timed_ms))
                    targets.append(None)
                    expected.append(m.deg(speed) * timed_ms / 1000.0)
                    speeds.append(speed)
                    active.append((m, "run-timed"))
                else:
                    counts = m.to_counts(mv["deg"])
                    targets.append(counts)
                    if counts == 0:
                        expected.append(0.0)
                        speeds.append(0)
                        active.append((m, "stop"))
                    else:
                        speed = max(MIN_SPEED_COUNTS, speed)
                        speeds.append(speed)
                        # The kernel is told no more than it can cover within the time bound (plus 20 %),
                        # so the move stays short even if this process dies before its own time cap.
                        reach = int(speed * self.op_ms / 1000.0 * 1.2) + m.to_counts(REACH_TOLERANCE_DEG) + 1
                        m.set("speed_sp", speed)
                        expected.append(min(abs(m.deg(counts)), m.deg(speed) * self.op_ms / 1000.0))
                        absolute.append((i, m, max(-reach, min(reach, counts))))
                m.set("stop_action", action)
            # Degree moves: the position is read immediately before its target is written, and once more
            # immediately before the command. The motor may still be coasting from the previous operation.
            goals = []
            for i, m, travel in absolute:
                start[i] = m.counts()
                goals.append(start[i] + travel)
                m.set("position_sp", goals[-1])
            for n in range(len(absolute)):
                i, m, travel = absolute[n]
                direction = 1 if travel > 0 else -1
                passed = (m.counts() - goals[n]) * direction >= 0
                if passed and m.get_int("speed") * direction > 0:
                    # Already past the target and still rolling the commanded way: an absolute move
                    # would drive it BACK. The travel is done; brake if asked, never reverse.
                    if action == "brake":
                        m.brake()
                    continue
                active.append((m, "run-to-abs-pos"))
            # Everything is set; the command writes follow back to back.
            for m, cmd in active:
                m.set("command", cmd)
            # The kernel counts from the command writes, and so does every time below: this process can be
            # held off the processor between two of those writes (a busy brick), and a motor whose command
            # came late is given its whole time all the same, never judged stalled before it could turn.
            t_run = now()
            if timed_ms is None and all(c == 0 for c in targets):
                reason = "completed"
            cap = t_run + (self.op_ms if timed_ms is None else timed_ms + 100) / 1000.0
            tol = [m.to_counts(REACH_TOLERANCE_DEG) for m in motors]
            at = start
            # The first look comes right behind the command: a move that is already there answers at once.
            wait = MOTION_TICK_S
            if any(c is not None and c != 0 and abs(c) <= tol[i] for i, c in enumerate(targets)):
                # A move inside the arrival tolerance is judged on "running" alone, and the driver needs
                # a moment to show it: this one gets the full tick.
                wait = TICK_S
            while reason is None:
                yield wait
                if task.flag:
                    reason = task.flag
                    break
                t = now()
                running = any("running" in m.state() for m in motors)
                at = [m.counts() for m in motors]
                if timed_ms is not None:
                    done = not running and (t - t_run) * 1000.0 >= timed_ms
                else:
                    # Judged on the encoders: every motor travelled its distance and none is running.
                    done = not running
                    for i in range(len(motors)):
                        want = targets[i]
                        went = (at[i] - start[i]) * (1 if want >= 0 else -1)
                        if want != 0 and went < abs(want) - tol[i]:
                            done = False
                if done or t >= cap:
                    # A motor that should have covered 4 degrees or more and did not turn is blocked.
                    blocked = False
                    for i in range(len(motors)):
                        if expected[i] >= 4 and abs(motors[i].deg(at[i] - start[i])) < 0.5:
                            blocked = True
                    reason = "stalled" if blocked else ("completed" if done else "timeout")
                elif timed_ms is not None:
                    wait = next_look(timed_ms / 1000.0 - (t - t_run), None)
                else:
                    left = []
                    for i in range(len(motors)):
                        want = targets[i]
                        if want != 0:
                            left.append((abs(want) - tol[i] - (at[i] - start[i]) * (1 if want >= 0 else -1), speeds[i]))
                    wait = next_look(None, left)
            if reason != "completed":
                for m in motors:
                    m.brake()
                yield TICK_S
            at = [m.counts() for m in motors]
        except Exception:
            for m in motors:
                try:
                    m.brake()
                except Exception:
                    pass
            raise
        finally:
            for m in motors:
                if m.owner == task.id:
                    m.owner = None
        for m in motors:
            m.stalled = reason == "stalled"
        if reason == "watchdog":
            self.fail(task.id, "robot_offline", "brick watchdog: no message for %d ms, motors were braked mid-command" % WATCHDOG_MS)
            return
        deltas = [tidy(motors[i].deg(at[i] - start[i])) for i in range(len(motors))]
        if shape == "pair":
            measured = {"left_deg": deltas[0], "right_deg": deltas[1]}
        elif shape == "absolute":
            measured = {"position_deg": tidy(motors[0].deg(at[0])), "degrees": deltas[0]}
        else:
            measured = {"degrees": deltas[0]}
        if reason == "timeout":
            measured["time_limited"] = True
        if clamped:
            measured.update(applied)
            if reason == "completed":
                reason = "clamped"
        self.done(task.id, measured, clamped, reason, t0)

    def stop(self, rid):
        errors = self.stop_all_now()             # first
        self.hush()
        for t in self.tasks:
            if (t.motors or t.talk) and t.flag is None:
                t.flag = "preempted"
                t.due = 0.0
        self.spawn(Task(rid, self.verify_stop(rid, errors)))

    def verify_stop(self, rid, errors):
        deadline = now() + STOP_VERIFY_S
        detail = "; ".join(errors)
        while True:
            moving = []
            for d in self.motor_dirs():
                try:
                    state = read_attr(os.path.join(d, "state")).split()
                    speed = read_int(os.path.join(d, "speed"))
                    if "running" in state or speed != 0:
                        moving.append("%s state=%s speed=%d" % (os.path.basename(d), " ".join(state) or "idle", speed))
                except (OSError, IOError, ValueError) as e:
                    moving.append("%s unreadable: %s" % (os.path.basename(d), e))
            if not moving or now() > deadline:
                break
            yield TICK_S
        stopped = not moving and not errors
        out = {"motors_stopped": stopped}
        if not stopped:
            out["detail"] = "; ".join(moving + ([detail] if detail else []))
        self.ok(rid, out)

    # ------------------------------------------------------------ power (run-direct)

    def run_power(self, task, m, pct, ms, clamped, applied, t0):
        """One timed operation of unregulated power: run-direct for `ms`, then brake. The guard's deadman is
        armed before run-direct is written and stays armed until the motor is braked."""
        reason = None
        start = 0
        at = 0
        try:
            start = m.counts()
            m.set("duty_cycle_sp", pct)
            self.direct[m.port] = task.id
            self.guard_pass()                    # armed before the command below
            m.set("command", "run-direct")
            self.duty[m.port] = pct
            end = now() + ms / 1000.0
            while True:
                yield max(MOTION_TICK_S, min(TICK_S, end - now()))
                if task.flag:
                    reason = task.flag
                    break
                if now() >= end:
                    break
            m.brake()
            self.duty[m.port] = 0
            yield TICK_S
            at = m.counts()
        except Exception:
            try:
                m.brake()
            except Exception:
                pass
            raise
        finally:
            self.duty[m.port] = 0
            if self.direct.get(m.port) == task.id:
                del self.direct[m.port]
            if m.owner == task.id:
                m.owner = None
        moved = m.deg(at - start)
        expected = m.deg(m.max_speed) * abs(pct) / 100.0 * ms / 1000.0
        if reason is None:
            reason = "stalled" if expected >= 4 and abs(moved) < 0.5 else "completed"
        m.stalled = reason == "stalled"
        if reason == "watchdog":
            self.fail(task.id, "robot_offline", "brick watchdog: no message for %d ms, motors were braked mid-command" % WATCHDOG_MS)
            return
        measured = {"degrees": tidy(moved)}
        if clamped:
            measured.update(applied)
            if reason == "completed":
                reason = "clamped"
        self.done(task.id, measured, clamped, reason, t0)

    def guard_pass(self):
        """Once per pass of the main loop: while run-direct is live anywhere, one byte to the guard arms and feeds
        its deadman; once it is not, one byte disarms it."""
        want = bool(self.direct)
        if not want and not self.guard_armed:
            return
        t = now()
        # a bridge held off the processor (stopped, starved) for most of the deadman may have been braked by the
        # guard: whatever runs on run-direct then has a braked motor under it, and a loop on it ends (run_loop)
        if want and self.guard_armed and t - self.guard_fed >= 0.8 * GUARD_DEADMAN_MS / 1000.0:
            self.deadman_lapsed = True
        if not want:
            self.deadman_lapsed = False
        self.guard_armed = want
        if self.guard is None or self.guard.stdin is None:
            return
        try:
            fd = self.guard.stdin.fileno()
            if fcntl is not None and not getattr(self, "guard_nonblocking", False):
                fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
                self.guard_nonblocking = True
            os.write(fd, b"a" if want else b"d")
            self.guard_fed = t
        except (OSError, IOError, ValueError):
            pass                                 # a full pipe is fed next pass; a gone guard is seen by run()

    def loop_hold(self):
        """A power output lasts hold_ms after its latest refresh, as on a brick that ends a timed run by itself:
        past it (a tick that is late) its power is set to 0 until the next refresh."""
        run = self.loop
        if run is None or run.ended:
            return
        t = now()
        for out in run.outputs:
            if out["command"] == "power" and not out["lapsed"] and out["at"] is not None and t - out["at"] > out["hold_s"]:
                try:
                    held_write(out["value_fd"], "0")
                except (OSError, IOError):
                    pass
                self.duty[out["motor"].port] = 0
                out["lapsed"] = True

    # ------------------------------------------------------------ loops

    def loop_reader(self, run, s):
        """-> a function that reads one signal of the plan through attributes held open: a float, or None."""
        kind, obj = self.find(s.get("device"))
        channel = s.get("channel")
        index = s.get("index")
        where = "loop.signals.%s: channel %s of %s" % (s.get("name"), json.dumps(channel), s.get("device"))
        run_fds = run.fds

        def hold(path):
            fd = held_open(path, False)
            run_fds.append(fd)
            return fd

        def guarded(fn):
            def read():
                try:
                    return fn()
                except (OSError, IOError, ValueError, ZeroDivisionError, IndexError, TypeError):
                    return None
            return read

        if kind == "motor":
            m = obj
            if channel == "position_deg":
                fd = hold(os.path.join(m.dir, "position"))
                return guarded(lambda: int(held_read(fd)) * 360.0 / m.cpr)
            if channel == "speed_deg_s":
                fd = hold(os.path.join(m.dir, "speed"))
                return guarded(lambda: int(held_read(fd)) * 360.0 / m.cpr)
            if channel == "stalled":
                return lambda: 1.0 if m.stalled else 0.0
            if channel == "power_pct":
                return lambda: float(self.duty.get(m.port, 0))
        elif kind == "motor_pair":
            m = self.motors[self.pair[0] if channel == "left_deg" else self.pair[1]]
            if channel in ("left_deg", "right_deg"):
                fd = hold(os.path.join(m.dir, "position"))
                return guarded(lambda: int(held_read(fd)) * 360.0 / m.cpr)
        elif kind == "battery":
            path = self.battery_path()
            if path is not None and channel in ("voltage_v", "low"):
                fd = hold(path)
                low = self.bounds["low_battery_v"]
                if channel == "voltage_v":
                    return guarded(lambda: int(held_read(fd)) / 1000000.0)
                return guarded(lambda: 1.0 if int(held_read(fd)) / 1000000.0 < low else 0.0)
        elif obj is not None and kind == GENERIC:
            if channel == "values":
                if isinstance(index, bool) or not isinstance(index, int) or index < 0:
                    raise BridgeError("invalid_argument", "%s: a loop reads one value of it: give index" % where)
                mode = obj.get("mode")
                scale = float(10 ** self.decimals_of(obj, mode))
                fd = hold(os.path.join(obj.dir, "value%d" % index))
                return guarded(lambda: float(held_read(fd)) / scale)
            raise BridgeError("invalid_argument", "%s: a loop reads numbers; this channel is text" % where)
        elif obj is not None:
            sensor = obj
            if kind == "touch" and channel == "presses":
                return lambda: float(sensor.presses)
            if channel in sensor.channels:
                mode = sensor.channels[channel][0]
                current = sensor.get("mode")
                if current != mode:
                    raise BridgeError("invalid_argument", "%s is not active (the sensor is in mode %s) and a loop never switches a sensor mode. Nothing was sent. Read the channel by name with read_device while the robot is idle, then start the loop." % (where, current))
                scale = float(10 ** self.decimals_of(sensor, mode))
                fds = [hold(os.path.join(sensor.dir, "value%d" % i)) for i in range(self.fetch_count(sensor, channel))]

                def read_sensor():
                    vals = [float(held_read(fd)) / scale for fd in fds]
                    value = self.decode(sensor, channel, vals)[0]
                    if isinstance(value, bool):
                        return 1.0 if value else 0.0
                    if isinstance(value, list):
                        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(value):
                            return None
                        return float(value[index])
                    return value
                return guarded(read_sensor)
        if channel is None or not isinstance(channel, str):
            raise BridgeError("invalid_argument", "%s: channel must be a string" % where)
        raise BridgeError("unsupported", "%s: this bridge reads no such channel in a loop" % where)

    def decimals_of(self, sensor, mode):
        decimals = sensor.decimals.get(mode)
        if decimals is None:
            try:
                decimals = sensor.decimals[mode] = sensor.get_int("decimals")
            except (OSError, IOError, ValueError):
                decimals = DEFAULT_DECIMALS.get(mode, 0)
        return decimals

    def loop_output(self, run, o, probe):
        """Checks one output of the plan and holds its attributes open. Nothing is written here."""
        kind, m = self.find(o.get("device"))
        command = o.get("command")
        where = "loop.outputs: command %s of %s" % (json.dumps(command), o.get("device"))
        if kind != "motor" or command not in ("power", "run_time"):
            raise BridgeError("unsupported", "%s: a loop drives the power and run_time commands of a motor" % where)
        needed = "run-direct" if command == "power" else "run-timed"
        if m.commands is not None and needed not in m.commands:
            raise BridgeError("unsupported", "motor on port %s (%s) does not offer %s; it offers: %s" % (m.port, m.driver, needed, " ".join(m.commands)))
        args = o.get("args") or {}
        brake = args.get("brake", True)
        if not isinstance(brake, bool):
            raise BridgeError("invalid_argument", "%s: brake must be true or false" % where)
        hold_ms = law_number(o.get("hold_ms"))
        out = {"motor": m, "command": command, "hold_ms": max(1, int(round(hold_ms))), "hold_s": hold_ms / 1000.0,
               "action": "brake" if brake else "coast", "at": None, "lapsed": False, "stopped": True, "probe": probe}
        value = os.path.join(m.dir, "duty_cycle_sp" if command == "power" else "speed_sp")
        out["value_fd"] = held_open(value, True)
        run.fds.append(out["value_fd"])
        if command == "run_time":
            out["command_fd"] = held_open(os.path.join(m.dir, "command"), True)
            run.fds.append(out["command_fd"])
        return out

    def loop_prepare(self, rid, msg, probe):
        """Checks a plan against the brick and holds its attributes open. Writes nothing; refuses with a typed error."""
        self.need_hello()
        if self.loop is not None:
            raise BridgeError("busy", "a loop already runs on this brick: one loop at a time")
        plan = msg.get("plan")
        if not isinstance(plan, dict):
            raise BridgeError("invalid_argument", "%s needs plan: a planned loop" % msg.get("op"))
        try:
            run = LoopRun(rid, plan)
        except (KeyError, TypeError, ValueError, AttributeError) as e:
            raise BridgeError("invalid_argument", "loop plan: missing or malformed %s" % e)
        try:
            for s in plan["signals"]:
                run.readers.append(self.loop_reader(run, s))
            for o in plan["outputs"]:
                out = self.loop_output(run, o, probe)
                if out["motor"] in run.motors:
                    raise BridgeError("invalid_argument", "loop.outputs: two outputs drive the motor on port %s" % out["motor"].port)
                run.outputs.append(out)
                run.motors.append(out["motor"])
            self.claim(run.motors)
        except BaseException:
            self.loop_close(run)
            raise
        return run

    def loop_close(self, run):
        for fd in run.fds:
            try:
                os.close(fd)
            except OSError:
                pass
        run.fds = []

    def loop_start(self, rid, msg):
        run = self.loop_prepare(rid, msg, False)
        for m in run.motors:
            m.owner = rid
        self.loop = run
        task = Task(rid, None, list(run.motors))
        run.task = task
        task.gen = self.run_loop(run)
        gc.disable()                             # no collection pause between two ticks; collected at the end
        self.ok(rid, {"loop": run.id})
        self.spawn(task)

    def loop_set(self, rid, msg):
        run = self.loop
        if run is None or run.ended or run.id != msg.get("loop"):
            raise BridgeError("illegal_state", "no loop %s runs on this brick" % json.dumps(msg.get("loop")))
        law_set(run.st, msg.get("params") or {}, msg.get("ramp_ms", 0))
        self.ok(rid, {"params": dict(run.st["params"])})

    def loop_refresh(self, run, i, u):
        """Refreshes output i with the value the law computed. A refresh supersedes the previous one."""
        out = run.outputs[i]
        m = out["motor"]
        pct = round_half(u)
        if out["probe"]:
            held_write(out["value_fd"], "0")
            return
        if out["command"] == "power":
            pct = max(-100, min(100, pct))
            held_write(out["value_fd"], "%d" % pct)
            self.duty[m.port] = pct
            out["at"] = now()
            out["lapsed"] = False
            return
        # run_time: a regulated speed for hold_ms, ended by the kernel; 0 brakes (or coasts, as its args say)
        if pct == 0:
            if not out["stopped"]:
                held_write(out["command_fd"], "stop")
                out["stopped"] = True
            return
        speed = max(1, int(round(abs(pct) / 100.0 * m.max_speed)))
        held_write(out["value_fd"], "%d" % (speed if pct > 0 else -speed))
        held_write(out["command_fd"], "run-timed")
        out["stopped"] = False

    def loop_outputs_start(self, run):
        """The writes a loop's outputs need once, ahead of the first refresh. run-direct only with the deadman armed."""
        direct = False
        for out in run.outputs:
            m = out["motor"]
            if out["command"] == "power":
                held_write(out["value_fd"], "0")
                self.direct[m.port] = run.id
                direct = True
            else:
                m.set("stop_action", out["action"])
                m.set("time_sp", out["hold_ms"])
        if direct:
            self.guard_pass()                    # armed before run-direct is written
        for out in run.outputs:
            if out["command"] == "power":
                out["motor"].set("command", "run-direct")
                self.duty[out["motor"].port] = 0
                out["at"] = now()

    def run_loop(self, run):
        """The loop's task: tick k is due at start + k periods. Each tick reads every input, steps the law and
        refreshes every output; the rate rule, the duration and every flag end it."""
        task = run.task
        t0 = now()
        run.sent = t0                            # the first telemetry line follows LOOP_START_TICKS ticks
        k = 0
        prev = None
        try:
            self.loop_outputs_start(run)
            while True:
                due = t0 + k * run.period_s
                yield max(0.0, due - now())
                if task.flag:
                    self.loop_finish(run, {"reason": "preempted" if task.flag == "preempted" else "timeout"})
                    return
                if self.deadman_lapsed:
                    # held off the processor however slow the loop's rate: the guard may have braked its motors
                    self.loop_finish(run, {"reason": "overrun"})
                    return
                at = now()
                if run.first is None:
                    run.first = at
                elif (at - run.first) * 1000.0 >= run.duration_ms:
                    self.loop_finish(run, {"reason": "completed"})
                    return
                # the rate: 3 ticks in a row later than a period, or more than 5 % of the ticks of a second
                late = at - due > run.period_s
                if late:
                    run.overruns += 1
                run.late_row = run.late_row + 1 if late else 0
                run.recent.append((at, late))
                while run.recent and run.recent[0][0] <= at - 1.0:
                    run.recent.pop(0)
                share = len([1 for r in run.recent if r[1]]) / float(len(run.recent))
                if run.late_row >= LOOP_LATE_IN_A_ROW or (at - run.first >= 1.0 and share > LOOP_LATE_SHARE):
                    self.loop_finish(run, {"reason": "overrun"})
                    return
                inputs = [r() for r in run.readers]
                dt = 0.0 if prev is None else (at - prev) * 1000.0
                if prev is not None:
                    run.periods.append(round(dt, 2))
                prev = at
                run.last_at = at
                u, end = law_step(run.st, inputs, dt)
                run.ticks += 1
                stats_record(run.stats, run.st)
                if end is not None:
                    self.loop_finish(run, end)
                    return
                for i in range(len(u)):
                    self.loop_refresh(run, i, u[i])
                if run.ticks == LOOP_START_TICKS or now() - run.sent >= LOOP_EVENT_S:
                    self.send(self.loop_telemetry(run, "loop"))
                k += 1
        except Exception as e:
            # a fault of this file or of the brick: the loop ends braked, and the computer is told why
            if not run.ended:
                self.loop_finish(run, {"reason": "input_lost"}, "%s: %s" % (type(e).__name__, e))

    def loop_telemetry(self, run, ev):
        w = stats_take(run.stats, run.st)
        age = 0.0 if run.first is None or run.last_at is None else (run.last_at - run.first) * 1000.0
        msg = {"ev": ev, "loop": run.id, "ticks": run.ticks, "overruns": run.overruns, "age_ms": round(age, 1),
               "periods": run.periods, "signals": w["signals"], "outputs": w["outputs"], "trace": w["trace"],
               "params": dict(run.st["params"])}
        run.periods = []
        run.sent = now()
        return msg

    def loop_finish(self, run, end, failure=None):
        """Every end of a loop: every driven motor braked first, then the bookkeeping, then one loop_end line."""
        if run.ended:
            return
        run.ended = True
        errors = []
        for m in run.motors:
            try:
                brake_now(m.dir)
            except (OSError, IOError) as e:
                errors.append("port %s: %s" % (m.port, e))
        for m in run.motors:
            self.duty[m.port] = 0
            if self.direct.get(m.port) == run.id:
                del self.direct[m.port]
            if m.owner == run.id:
                m.owner = None
            m.stalled = False
        if not self.direct:
            self.deadman_lapsed = False          # nothing runs on run-direct: the next arming starts afresh
        self.loop_close(run)
        if self.loop is run:
            self.loop = None
        gc.enable()
        msg = self.loop_telemetry(run, "loop_end")
        msg["reason"] = end["reason"]
        if end.get("guard") is not None:
            msg["guard"] = end["guard"]
        if errors:
            msg["brake_error"] = "; ".join(errors)
        if failure:
            msg["failure"] = failure
        self.send(msg)
        gc.collect()

    def loop_probe(self, rid, msg):
        ticks = msg.get("ticks", 1000)
        if isinstance(ticks, bool) or not isinstance(ticks, int) or not 1 <= ticks <= PROBE_MAX_TICKS:
            raise BridgeError("invalid_argument", "loop_probe: ticks must be an integer from 1 to %d" % PROBE_MAX_TICKS)
        run = self.loop_prepare(rid, msg, True)
        for m in run.motors:
            m.owner = rid
        task = Task(rid, None, list(run.motors))
        task.gen = self.run_probe(task, run, ticks)
        self.spawn(task)

    def run_probe(self, task, run, ticks):
        """Ticks of the plan back to back, every output written as 0 with no run command, in slices of 20 ms
        between which the main loop serves the link. -> what one tick costs, and the rate it allows."""
        costs = []
        dt = law_number(run.plan["period_ms"])
        try:
            gc.disable()
            while len(costs) < ticks and not task.flag:
                until = now() + 0.02
                while len(costs) < ticks and now() < until:
                    a = now()
                    inputs = [r() for r in run.readers]
                    u, end = law_step(run.st, inputs, dt)
                    stats_record(run.stats, run.st)
                    if end is not None:
                        run.st = law_start(run.plan)
                        run.stats = stats_start(run.st)
                    for i in range(len(u)):
                        self.loop_refresh(run, i, u[i])
                    costs.append((now() - a) * 1000.0)
                yield 0.0
        finally:
            gc.enable()
            for m in run.motors:
                if m.owner == task.id:
                    m.owner = None
            self.loop_close(run)
        if task.flag:
            raise BridgeError("busy" if task.flag == "preempted" else "robot_offline", "loop_probe was ended (%s) after %d ticks" % (task.flag, len(costs)))
        costs.sort()
        p99 = costs[min(len(costs) - 1, max(0, int(math.ceil(0.99 * len(costs))) - 1))]
        fits = [r for r in PROBE_RATES if p99 <= 500.0 / r]
        self.ok(task.id, {"probe": {
            "ticks": len(costs), "signals": len(run.readers), "outputs": len(run.outputs),
            "mean_ms": round(sum(costs) / len(costs), 3), "p50_ms": round(costs[len(costs) // 2], 3),
            "p99_ms": round(p99, 3), "max_ms": round(costs[-1], 3),
            "max_rate_hz": fits[-1] if fits else max(1, int(500.0 / p99)) if p99 > 0 else PROBE_RATES[-1],
            "python": "%d.%d.%d" % tuple(sys.version_info[:3]),
        }})

    # ------------------------------------------------------------ scheduler

    def spawn(self, task):
        task.due = 0.0
        self.tasks.append(task)
        self.step(task)

    def step(self, task):
        try:
            delay = next(task.gen)
            task.due = now() + delay
            return
        except StopIteration:
            pass
        except BridgeError as e:
            self.fail(task.id, e.code, e.message)
        except Exception as e:
            self.fail(task.id, "internal", "%s: %s" % (type(e).__name__, e))
        if task in self.tasks:
            self.tasks.remove(task)

    def handle(self, raw):
        self.wd_tripped = False
        rid = None
        try:
            try:
                msg = json.loads(raw.decode("utf-8"))
            except ValueError as e:
                raise BridgeError("invalid_argument", "not a JSON line: %s" % e)
            if not isinstance(msg, dict):
                raise BridgeError("invalid_argument", "a request must be a JSON object")
            rid = msg.get("id")
            op = msg.get("op")
            if op == "hb":
                self.send({"ev": "hb"})
            elif op == "hello":
                self.hello(rid, msg)
            elif op == "read":
                self.read(rid, msg)
            elif op == "read_many":
                self.read_many(rid, msg)
            elif op == "command":
                self.command(rid, msg)
            elif op == "abort":
                for t in self.tasks:
                    if t.id == msg.get("target") and (t.motors or t.talk) and t.flag is None:
                        t.flag = "preempted"
                        t.due = 0.0
            elif op == "stop":
                self.stop(rid)
            elif op == "loop_start":
                self.loop_start(rid, msg)
            elif op == "loop_set":
                self.loop_set(rid, msg)
            elif op == "loop_probe":
                self.loop_probe(rid, msg)
            else:
                raise BridgeError("invalid_argument", "unknown op %s; ops: hello, read, read_many, command, abort, stop, hb, loop_start, loop_set, loop_probe" % json.dumps(op))
        except BridgeError as e:
            self.fail(rid, e.code, e.message)
        except (OSError, IOError) as e:
            self.fail(rid, "internal", "sysfs: %s" % e)
        except Exception as e:
            self.fail(rid, "internal", "%s: %s" % (type(e).__name__, e))

    def run(self):
        for target in (self.reader, self.writer):
            th = threading.Thread(target=target)
            th.daemon = True
            th.start()
        while True:
            wait = TICK_S
            t = now()
            for task in self.tasks:
                wait = min(wait, max(0.001, task.due - t))
            try:
                item = self.inq.get(timeout=wait)
            except queue.Empty:
                item = False
            while item is not False:
                if item is None:
                    return                      # stdin closed: main() brakes everything
                if item.strip():
                    self.handle(item)
                try:
                    item = self.inq.get_nowait()
                except queue.Empty:
                    item = False
            if self.writer_dead[0]:
                return
            if self.guard is not None and self.guard.poll() is not None:
                # No guard, no motion: brake first, say why, end. main() brakes once more on the way out.
                self.stop_all_now()
                sys.stderr.write("ev3dev_bridge: the guard process ended (exit %s); braked every motor and ending\n" % self.guard.returncode)
                self.send({"ev": "guard_lost"})
                time.sleep(0.05)                # the writer thread sends the line
                self.exit_code = EXIT_GUARD_LOST
                return
            self.watchdog()
            self.guard_pass()
            self.loop_hold()
            t = now()
            for task in list(self.tasks):
                if task.due <= t and task in self.tasks:
                    self.step(task)
            if t - self.last_touch >= TICK_S:
                self.last_touch = t
                self.sample_touch()
            self.beeps = [p for p in self.beeps if p.poll() is None]


def main(argv):
    root = os.environ.get("SYSFS_ROOT") or os.sep
    args = list(argv[1:])
    while args:
        a = args.pop(0)
        if a == "--root" and args:
            root = args.pop(0)
        elif a == "--version":
            sys.stdout.write(VERSION + "\n")
            return 0
        else:
            sys.stderr.write("usage: ev3dev_bridge.py [--root DIR] [--version]\n")
            return 2
    if not os.path.isdir(os.path.join(root, "sys", "class")):
        sys.stderr.write("ev3dev_bridge: %s has no sys/class; is this an ev3dev brick?\n" % root)
        return 2
    bridge = Bridge(root)
    try:
        bridge.guard = start_guard(root)
        bridge.no_guard = "the guard process ended by itself"
    except (OSError, ValueError) as e:
        bridge.no_guard = "the guard process could not be started: %s" % e

    def on_signal(signum, frame):
        raise SystemExit(0)

    for name in ("SIGTERM", "SIGHUP", "SIGINT"):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), on_signal)
            except (ValueError, OSError):
                pass
    try:
        bridge.run()
    finally:
        try:
            bridge.stop_all_now()   # stdin closed, signal, broken stdout or a crash: motors are braked
        finally:
            bridge.hush()           # and the speech is cut
    return bridge.exit_code


def leave(code):
    """Ends the process with `code` and nothing else. The reader thread sits in a read of stdin and the writer
    thread may hold stdout: an interpreter that shuts down around them can abort with a fatal error of its own
    (seen on Python 3.13), which would reach the computer as this bridge's last words. os._exit skips that
    shutdown; the motors are braked and every line is written by the time this is called."""
    try:
        sys.stderr.flush()
    except Exception:
        pass
    os._exit(code)


def run(argv):
    """The process: main, then leave with its code. The driver starts it as `import ev3dev_bridge;
    ev3dev_bridge.run([...])`, so Python keeps this file's compiled bytecode in __pycache__ and a start
    skips compiling it: on an EV3 that is several seconds of the hello."""
    try:
        code = main(argv)
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else EXIT_OK
    except BaseException as e:   # a bug: one line, then out
        try:
            sys.stderr.write("ev3dev_bridge: ended on an unexpected error: %r\n" % (e,))
        except Exception:
            pass
        code = EXIT_CRASH
    leave(code)


if __name__ == "__main__":
    run(sys.argv)
