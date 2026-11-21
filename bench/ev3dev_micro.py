#!/usr/bin/env python3
"""Per-operation time of the ev3dev bridge, measured in Python with time.perf_counter.

Runs the real bridge (packages/driver-ev3dev/bridge/ev3dev_bridge.py) as a child process over
stdin/stdout, against a fake sysfs tree (the one the driver's tests build), and times each request
from the write of its line to the arrival of its reply. No ssh and no brick: this is the bridge's own
processing plus two local pipes, which is the floor every ev3dev operation pays.

usage: ev3dev_micro.py <bridge.py> <fake sysfs root> <samples> <cold samples>
Prints one JSON object: {"python": "...", "samples": {name: [ms, ...]}}.

For run_pair a thread plays the kernel motor driver with a motor that arrives at once (it writes
position = position_sp as soon as it sees the run command), so the sample is the bridge's overhead
around a move (writing the command, noticing the arrival on its 10 ms tick, braking, answering),
not motion time.
"""
import glob
import json
import os
import subprocess
import sys
import threading
import time

CONFIG = {
    "bounds": {"max_speed_pct": 60, "max_op_ms": 3000, "low_battery_v": 6.5, "max_tone_ms": 5000, "speech_volume_pct": 80},
    "pair": {"left": "B", "right": "C"},
}


class Bridge(object):
    def __init__(self, bridge, root):
        env = dict(os.environ)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        self.started = time.perf_counter()
        self.proc = subprocess.Popen(
            [sys.executable, "-u", bridge, "--root", root], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env
        )
        self.next_id = 0

    def send(self, msg):
        self.next_id += 1
        msg = dict(msg, id=self.next_id)
        self.proc.stdin.write((json.dumps(msg, separators=(",", ":")) + "\n").encode("utf-8"))
        return self.next_id

    def flush(self):
        self.proc.stdin.flush()

    def wait(self, rid):
        """The reply to request `rid` (events such as {"ev":"hb"} are skipped). Fails loud on an error reply."""
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("the bridge closed its stdout (exit code %s)" % self.proc.poll())
            reply = json.loads(line.decode("utf-8"))
            if reply.get("id") != rid:
                continue
            if not reply.get("ok"):
                raise RuntimeError("the bridge answered an error: %s" % line.decode("utf-8").strip())
            return reply

    def call(self, msg):
        """One request and its reply: (reply, ms)."""
        t0 = time.perf_counter()
        rid = self.send(msg)
        self.flush()
        reply = self.wait(rid)
        return reply, (time.perf_counter() - t0) * 1000.0

    def close(self):
        self.proc.stdin.close()
        self.proc.wait()


def play_motors(root, stop):
    """The kernel's part for a motor that arrives at once: the run command lands on its target."""
    dirs = sorted(glob.glob(os.path.join(root, "sys", "class", "tacho-motor", "motor*")))
    while not stop.is_set():
        for d in dirs:
            try:
                with open(os.path.join(d, "command")) as f:
                    cmd = f.read().strip()
                if cmd != "run-to-abs-pos":
                    continue
                with open(os.path.join(d, "position_sp")) as f:
                    target = f.read().strip()
                if target == "":
                    continue  # the bridge is in the middle of a write
                with open(os.path.join(d, "position"), "w") as f:
                    f.write(target + "\n")
                with open(os.path.join(d, "command"), "w") as f:
                    f.write("done\n")
            except (OSError, IOError):
                pass
        time.sleep(0.0002)


def main(argv):
    bridge, root, n, cold = argv[1], argv[2], int(argv[3]), int(argv[4])
    samples = {"cold_spawn_hello": [], "hello": [], "read_one": [], "read_all": [], "run_pair": [], "stop": []}

    # cold: a new Python process, the bridge imported, the first hello answered
    for _ in range(cold):
        b = Bridge(bridge, root)
        b.flush()
        rid = b.send({"op": "hello", "config": CONFIG})
        b.flush()
        b.wait(rid)
        samples["cold_spawn_hello"].append((time.perf_counter() - b.started) * 1000.0)
        b.close()

    b = Bridge(bridge, root)
    inv, _ = b.call({"op": "hello", "config": CONFIG})
    sensors = ["S%s" % s["port"] for s in inv["sensors"]]
    ultrasonic = ["S%s" % s["port"] for s in inv["sensors"] if s.get("kind") == "ultrasonic"]
    if not ultrasonic:
        raise RuntimeError("the fake brick has no ultrasonic sensor: %s" % json.dumps(inv["sensors"]))
    devices = [m["port"] for m in inv["motors"]] + ["pair"] + sensors
    if inv["capabilities"].get("battery"):
        devices.append("battery")
    if inv["capabilities"].get("buttons"):
        devices.append("buttons")
    warm = max(5, n // 10)

    for i in range(warm + n):
        _, ms = b.call({"op": "hello", "config": CONFIG})
        if i >= warm:
            samples["hello"].append(ms)
    for i in range(warm + n):
        _, ms = b.call({"op": "read", "device": ultrasonic[0], "channels": ["distance_cm"]})
        if i >= warm:
            samples["read_one"].append(ms)
    # read_all as the runtime issues it: one read per device, all written before any reply is awaited
    for i in range(warm + n):
        t0 = time.perf_counter()
        ids = [b.send({"op": "read", "device": d}) for d in devices]
        b.flush()
        for rid in ids:
            b.wait(rid)
        if i >= warm:
            samples["read_all"].append((time.perf_counter() - t0) * 1000.0)

    stop = threading.Event()
    player = threading.Thread(target=play_motors, args=(root, stop))
    player.daemon = True
    player.start()
    try:
        for i in range(warm + n):
            args = {"left_deg": 20 if i % 2 == 0 else -20, "right_deg": 20 if i % 2 == 0 else -20, "speed_pct": 30}
            reply, ms = b.call({"op": "command", "device": "pair", "command": "run_pair", "args": args})
            if reply.get("result", reply).get("reason") != "completed":
                raise RuntimeError("run_pair did not complete: %s" % json.dumps(reply))
            if i >= warm:
                samples["run_pair"].append(ms)
    finally:
        stop.set()
        player.join()
    for i in range(warm + n):
        reply, ms = b.call({"op": "stop"})
        if reply.get("result", reply).get("motors_stopped") is not True:
            raise RuntimeError("stop was not verified: %s" % json.dumps(reply))
        if i >= warm:
            samples["stop"].append(ms)
    b.close()
    sys.stdout.write(
        json.dumps({"python": "%d.%d.%d" % tuple(sys.version_info[:3]), "devices": devices, "samples": samples}) + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
