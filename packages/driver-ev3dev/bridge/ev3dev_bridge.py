#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""On-brick bridge for an ev3dev LEGO EV3: JSON lines on stdin, JSON lines on stdout.

Runs on the brick's Python 3.5 (ev3dev-stretch) with the standard library only and talks to
the kernel drivers through sysfs. No f-strings, no dataclasses, no asyncio.

Requests (one JSON object per line; every reply echoes "id"):
  {"op":"hello","id":1,"config":{"bounds":{"max_speed_pct":..,"max_op_ms":..,"low_battery_v":..,"max_tone_ms":..},
                                 "pair":{"left":"B","right":"C"}}}
  {"op":"read","id":2,"device":"S4","channels":["proximity_pct"],"allow_mode_switch":false}
  {"op":"command","id":3,"device":"B","command":"run_degrees","args":{"degrees":90,"speed_pct":30}}
  {"op":"abort","target":3}            no reply; command 3 answers with reason "preempted"
  {"op":"stop","id":4}                 brakes every motor, verifies, answers motors_stopped
  {"op":"hb"}                          answers {"ev":"hb"}
Replies: {"id":n,"ok":true,...} or {"id":n,"ok":false,"code":<contract ErrorCode>,"message":...}.
Events:  {"ev":"hb"}, {"ev":"watchdog","cause":"silence"}.

Safety rules of this file:
  * Motion uses only run-to-abs-pos and run-timed, which the kernel driver bounds by itself.
    run-forever and run-direct are never written. A degree move is always sent as an absolute
    target = the position read at the start of the operation + the delta. run-to-rel-pos is
    not used: on a real brick it counts from the previous target, not from where the motor
    is, so after a coasting overshoot the next relative move ran backward.
  * One command is one operation, limited by time here on the brick: hello's max_op_ms of
    motion, never above MAX_OP_MS. The watchdog covers a dead link during a long operation. A degree move that has not arrived by then is braked and reported as it stands.
  * A read never writes. A channel that needs another sensor mode answers
    "mode_switch_required" unless the request names it and sets allow_mode_switch.
  * Watchdog: when no line arrives for WATCHDOG_MS, or stdin closes, or the process gets a
    termination signal, every tacho motor gets stop_action=brake and command=stop. The stop is
    written before anything else is done about it.
  * The main loop never blocks: stdin and stdout live in their own threads, waits are tasks.

Device names here are local ("B", "pair", "S4", "battery"); the provider adds its id prefix.
"""
import glob
import json
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

VERSION = "1"
WATCHDOG_MS = 1000
MAX_OP_MS = 3000         # ceiling for the motion one command may cause; hello's max_op_ms can only lower it
TICK_S = 0.01
MODE_SWITCH_S = 0.1
STOP_VERIFY_S = 0.8
REACH_TOLERANCE_DEG = 3.0
MIN_SPEED_COUNTS = 10

BOUND_KEYS = ["max_speed_pct", "max_op_ms", "low_battery_v", "max_tone_ms"]
LED_PATTERNS = ["off", "green", "red", "orange", "green_flash", "red_flash", "orange_flash",
                "green_pulse", "red_pulse", "orange_pulse"]
LED_COLORS = {"off": (0, 0), "green": (0, 255), "red": (255, 0), "orange": (255, 128)}
# Linux input key codes of the brick buttons, in the contract's order.
BUTTON_KEYS = [("up", 103), ("enter", 28), ("down", 108), ("right", 106), ("left", 105), ("back", 14)]

# driver_name -> (kind, {channel: (mode, number of values)})
SENSORS = {
    "lego-ev3-touch": ("touch", {"pressed": ("TOUCH", 1)}),
    "lego-ev3-color": ("color", {"reflected_pct": ("COL-REFLECT", 1), "ambient_pct": ("COL-AMBIENT", 1),
                                 "color": ("COL-COLOR", 1), "rgb": ("RGB-RAW", 3)}),
    "lego-ev3-us": ("ultrasonic", {"distance_cm": ("US-DIST-CM", 1)}),
    "lego-ev3-gyro": ("gyro", {"angle_deg": ("GYRO-ANG", 1), "rate_deg_s": ("GYRO-RATE", 1)}),
    "lego-ev3-ir": ("infrared", {"proximity_pct": ("IR-PROX", 1), "beacon_heading": ("IR-SEEK", 2),
                                 "beacon_distance_pct": ("IR-SEEK", 2), "remote_buttons": ("IR-REMOTE", 1)}),
}
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
    with open(path, "r") as f:
        return f.read().strip()


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
        self.kind = SENSORS[self.driver][0]
        self.channels = SENSORS[self.driver][1]
        self.modes = read_list(os.path.join(directory, "modes"))
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
        return {"port": self.port, "address": self.address, "driver_name": self.driver,
                "kind": self.kind, "mode": mode, "modes": self.modes,
                "channel_modes": dict((c, self.channels[c][0]) for c in self.channels)}


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
        self.motors = {}
        self.sensors = {}
        self.ignored = []
        self.tasks = []
        self.beeps = []
        self.last_touch = 0.0

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

    def watchdog(self):
        if self.wd_tripped:
            return
        if (now() - self.last_rx[0]) * 1000.0 <= WATCHDOG_MS:
            return
        self.stop_all_now()                      # first, before any bookkeeping or output
        self.wd_tripped = True
        for t in self.tasks:
            if t.motors and t.flag is None:
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
                if not m or driver not in SENSORS:
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
        pair = config.get("pair") or {}
        left, right = pair.get("left"), pair.get("right")
        if left not in list("ABCD") or right not in list("ABCD") or left == right:
            raise BridgeError("misconfigured", "config.pair needs two different ports A-D as left and right")
        self.bounds = dict((k, b[k]) for k in BOUND_KEYS)
        self.op_ms = int(max(1, min(MAX_OP_MS, b["max_op_ms"])))   # never above MAX_OP_MS, whatever the config says
        self.pair = (left, right)
        self.scan()
        ports = []
        for d in sorted(glob.glob(self.p("sys", "class", "lego-port", "port*"))):
            try:
                ports.append({"address": read_attr(os.path.join(d, "address")), "status": read_attr(os.path.join(d, "status"))})
            except (OSError, IOError):
                pass
        leds = all(os.path.exists(self.led_path(side, color, "brightness")) for side in (0, 1) for color in ("red", "green"))
        self.ok(rid, {
            "bridge": VERSION,
            "python": "%d.%d.%d" % tuple(sys.version_info[:3]),
            "watchdog_ms": WATCHDOG_MS,
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
            },
        })

    def need_hello(self):
        if self.bounds is None:
            raise BridgeError("misconfigured", "send hello with config.bounds before any other request")

    def find(self, device):
        """-> (kind, object or None)"""
        if device in self.motors:
            return "motor", self.motors[device]
        if device == "pair":
            if self.pair[0] in self.motors and self.pair[1] in self.motors:
                return "motor_pair", None
        elif isinstance(device, str) and re.match(r"^S[1-4]$", device) and int(device[1]) in self.sensors:
            s = self.sensors[int(device[1])]
            return s.kind, s
        elif device in ("speaker", "display", "led", "buttons", "battery"):
            return device, None
        names = sorted(self.motors) + (["pair"] if self.pair[0] in self.motors and self.pair[1] in self.motors else [])
        names += ["S%d" % k for k in sorted(self.sensors)] + ["speaker", "display", "led", "buttons", "battery"]
        raise BridgeError("unknown_device", "unknown device %s; devices: %s" % (json.dumps(device), ", ".join(names)))

    # ------------------------------------------------------------ read

    def read(self, rid, msg):
        self.need_hello()
        kind, obj = self.find(msg.get("device"))
        asked = msg.get("channels")
        if kind == "motor":
            known = ["position_deg", "speed_deg_s", "stalled"]
        elif kind == "motor_pair":
            known = ["left_deg", "right_deg"]
        elif kind == "battery":
            known = ["voltage_v", "low"]
        elif kind == "buttons":
            known = ["pressed"]
        elif obj is not None:
            known = [c for c in ["pressed", "presses", "reflected_pct", "ambient_pct", "color", "rgb", "distance_cm",
                                 "angle_deg", "rate_deg_s", "proximity_pct", "beacon_heading", "beacon_distance_pct",
                                 "remote_buttons"] if c in obj.channels or (kind == "touch" and c == "presses")]
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
            elif kind == "motor_pair":
                l, r = self.motors[self.pair[0]], self.motors[self.pair[1]]
                values["left_deg"] = (tidy(l.deg(l.counts())), None)
                values["right_deg"] = (tidy(r.deg(r.counts())), None)
            elif kind == "battery":
                path = self.battery_path()
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

    def reply_readings(self, rid, names, values, extra=None):
        out = []
        for n in names:
            value, error = values[n]
            item = {"channel": n, "value": value}
            if value is None:
                item["error"] = error or "no value"
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
        k = sensor.kind
        if k == "touch":
            return (vals[0] >= 0.5, None)
        if k == "gyro":
            r = int(round(vals[0]))
            return (0 if r == 0 else -r, None)   # native clockwise-positive -> contract counter-clockwise-positive
        if channel == "rgb":
            return ([int(round(v)) for v in vals[:3]], None)
        if channel == "distance_cm":
            return (tidy(vals[0]), None)
        if channel in ("beacon_heading", "beacon_distance_pct"):
            if vals[1] < 0 or vals[1] > 100:
                return (None, "no beacon in view on channel 1")
            return (int(round(vals[0] if channel == "beacon_heading" else vals[1])), None)
        return (int(round(vals[0])), None)

    def sensor_values(self, sensor, mode, count, switch):
        """Generator: leaves the values of `mode` in self.got. Writes the mode only when `switch` is true."""
        if sensor.modes is not None and mode not in sensor.modes:
            raise BridgeError("unsupported", "sensor %s has no mode %s; it offers: %s" % (sensor.driver, mode, " ".join(sensor.modes)))
        if sensor.get("mode") != mode:
            if not switch:
                raise BridgeError("mode_switch_required", "mode_switch_required")
            sensor.set("mode", mode)
            yield MODE_SWITCH_S
        try:
            decimals = sensor.get_int("decimals")
        except (OSError, IOError, ValueError):
            decimals = DEFAULT_DECIMALS.get(mode, 0)
        scale = float(10 ** decimals)
        self.got = [sensor.get_float("value%d" % i) / scale for i in range(count)]

    def read_sensor(self, rid, sensor, names, switch):
        values = {}
        for n in names:
            if n in values:
                continue
            if sensor.kind == "touch" and n == "presses":
                values[n] = (sensor.presses, None)
                continue
            mode = sensor.channels[n][0]
            same = [m for m in names if m in sensor.channels and sensor.channels[m][0] == mode]
            count = max(sensor.channels[m][1] for m in same)
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
        mode = None
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

    def gyro_reset(self, rid, sensor, t0):
        # Leaving angle mode and coming back zeroes the angle (the sensor has no reset command).
        for mode in ("GYRO-RATE", "GYRO-ANG"):
            for delay in self.sensor_values(sensor, mode, 1, True):
                yield delay
        value, _ = self.decode(sensor, "angle_deg", self.got)
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
                    active.append((m, "run-timed"))
                else:
                    counts = m.to_counts(mv["deg"])
                    targets.append(counts)
                    if counts == 0:
                        expected.append(0.0)
                        active.append((m, "stop"))
                    else:
                        speed = max(MIN_SPEED_COUNTS, speed)
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
            if timed_ms is None and all(c == 0 for c in targets):
                reason = "completed"
            cap = t0 + (self.op_ms if timed_ms is None else timed_ms + 100) / 1000.0
            tol = [m.to_counts(REACH_TOLERANCE_DEG) for m in motors]
            at = start
            while reason is None:
                yield TICK_S
                if task.flag:
                    reason = task.flag
                    break
                t = now()
                running = any("running" in m.state() for m in motors)
                at = [m.counts() for m in motors]
                if timed_ms is not None:
                    done = not running and (t - t0) * 1000.0 >= timed_ms
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
        for t in self.tasks:
            if t.motors and t.flag is None:
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

    # ------------------------------------------------------------ loop

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
            elif op == "command":
                self.command(rid, msg)
            elif op == "abort":
                for t in self.tasks:
                    if t.id == msg.get("target") and t.motors and t.flag is None:
                        t.flag = "preempted"
                        t.due = 0.0
            elif op == "stop":
                self.stop(rid)
            else:
                raise BridgeError("invalid_argument", "unknown op %s; ops: hello, read, command, abort, stop, hb" % json.dumps(op))
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
            self.watchdog()
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
        bridge.stop_all_now()   # stdin closed, signal, broken stdout or a crash: motors are braked
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
