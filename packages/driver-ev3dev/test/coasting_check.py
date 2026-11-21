"""Regression check run by provider.test.ts: a motor still coasting when a degree operation starts.

usage: coasting_check.py <bridge file> <fake root>
Loads the bridge as a module, replaces motor B's encoder with a scripted sequence (the motor keeps
rolling backward between the bridge's reads) and prints one JSON line with what the bridge did.
"""
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("ev3dev_bridge", sys.argv[1])
bridge_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_mod)


def run(positions, speed):
    bridge = bridge_mod.Bridge(sys.argv[2])
    bridge.hello(1, {"config": {"bounds": {"max_speed_pct": 60, "max_op_ms": 250, "low_battery_v": 6.5, "max_tone_ms": 1000},
                                "pair": {"left": "B", "right": "C"}}})
    motor = bridge.motors["B"]
    for name in ("command", "position_sp"):
        bridge_mod.write_attr(os.path.join(motor.dir, name), "")
    seq = list(positions)
    motor.counts = lambda: seq.pop(0) if len(seq) > 1 else seq[0]
    real_get = motor.get
    motor.get = lambda name: str(speed) if name == "speed" else real_get(name)
    bridge.command(2, {"device": "B", "command": "run_degrees", "args": {"degrees": -27, "speed_pct": 25, "brake": False}})
    for _ in range(200):
        if not bridge.tasks:
            break
        bridge.step(bridge.tasks[0])
    replies = []
    while not bridge.outq.empty():
        replies.append(json.loads(bridge.outq.get().decode("utf-8")))
    result = [r for r in replies if r.get("id") == 2][0]
    return {"command": real_get("command"), "position_sp": real_get("position_sp"), "reply": result}


print(json.dumps({
    # reads: op start -33, before position_sp -40 (target -67), before command -70: already past, still rolling back
    "passed": run([-33, -40, -70, -75, -80], -260),
    # same, but at the command the motor is at -50: the target is still ahead
    "ahead": run([-33, -40, -50, -60, -67], -260),
}))
