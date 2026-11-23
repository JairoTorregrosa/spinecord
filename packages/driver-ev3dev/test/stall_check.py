"""Regression check run by provider.test.ts: a bridge held off the processor between the command writes of a pair.

usage: stall_check.py <bridge file> <fake root> <hold ms>
Loads the bridge as a module, plays the kernel for motors B and C (each reaches its target 40 ms after its
command is written) and makes the bridge lose <hold ms> right before it writes C's command, as a busy brick does
to it. Runs run_pair and prints one JSON line: the reply. A bridge that counts its time bound from before its
writes judges C before C could turn: reason stalled, right_deg 0.
"""
import importlib.util
import json
import sys
import time

spec = importlib.util.spec_from_file_location("ev3dev_bridge", sys.argv[1])
bridge_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_mod)
hold_s = int(sys.argv[3]) / 1000.0

bridge = bridge_mod.Bridge(sys.argv[2])
bridge.hello(1, {"config": {"bounds": {"max_speed_pct": 60, "max_op_ms": 250, "low_battery_v": 6.5, "max_tone_ms": 1000, "speech_volume_pct": 100},
                            "pair": {"left": "B", "right": "C"}}})


def play(motor, late):
    """The kernel of one motor: it runs to position_sp, arriving 40 ms after its command is written."""
    state = {"at": 0, "goal": 0, "cmd_at": None}
    real_set = motor.set

    def set_attr(name, value):
        if name == "position_sp":
            state["goal"] = int(value)
        if name == "command":
            if late:
                time.sleep(hold_s)                # the bridge is held off the processor here
            state["cmd_at"] = time.monotonic()
        real_set(name, value)

    def moving():
        return state["cmd_at"] is not None and time.monotonic() - state["cmd_at"] < 0.04

    def counts():
        if state["cmd_at"] is not None and not moving():
            state["at"] = state["goal"]
        return state["at"]

    motor.set = set_attr
    motor.counts = counts
    motor.state = lambda: ["running"] if moving() else []
    real_get_int = motor.get_int
    motor.get_int = lambda name: 0 if name == "speed" else real_get_int(name)


play(bridge.motors["B"], False)
play(bridge.motors["C"], True)
bridge.command(2, {"device": "pair", "command": "run_pair", "args": {"left_deg": 100, "right_deg": -50, "speed_pct": 40}})
deadline = time.monotonic() + 5
while bridge.tasks and time.monotonic() < deadline:
    task = bridge.tasks[0]
    time.sleep(max(0.0, task.due - time.monotonic()))
    bridge.step(task)
replies = []
while not bridge.outq.empty():
    replies.append(json.loads(bridge.outq.get().decode("utf-8")))
print(json.dumps([r for r in replies if r.get("id") == 2][0]))
