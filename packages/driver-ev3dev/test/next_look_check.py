"""When the bridge looks at a running motor again: next_look() of the bridge, checked on its own.

usage: next_look_check.py <bridge file>
Prints one JSON line with the waits, in seconds, for the cases named below.
"""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("ev3dev_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

out = {
    "tick": bridge.TICK_S,
    "motion_tick": bridge.MOTION_TICK_S,
    # a degree move: 300 counts to go at 300 counts/s is 1 s away -> the usual tick, no busier than before
    "far": bridge.next_look(None, [(300, 300)]),
    # 3 counts to go at 300 counts/s is 10 ms away -> half of it
    "near": bridge.next_look(None, [(3, 300)]),
    # the farthest motor decides
    "pair": bridge.next_look(None, [(1, 300), (3, 300)]),
    # there (or past it), waiting for the driver to stop saying "running": the shortest wait
    "arrived": bridge.next_look(None, [(0, 300), (-4, 300)]),
    "no_travel": bridge.next_look(None, []),
    # a timed run: when its time is up, inside the same two limits
    "timed_long": bridge.next_look(0.2, None),
    "timed_short": bridge.next_look(0.004, None),
    "timed_over": bridge.next_look(-0.01, None),
}
sys.stdout.write(json.dumps(out) + "\n")
