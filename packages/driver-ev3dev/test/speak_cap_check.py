"""Check run by speak.test.ts: a phrase that outlasts the speech cap is cut and reported.

usage: speak_cap_check.py <bridge file> <fake root>      (PATH holds the stub espeak and aplay)
Loads the bridge as a module, lowers SPEAK_MAX_MS so the test does not take 15 s, starts a phrase the stub
aplay "plays" for longer than that, and prints one JSON line with the reply.
"""
import importlib.util
import json
import sys
import time

spec = importlib.util.spec_from_file_location("ev3dev_bridge", sys.argv[1])
bridge_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_mod)
bridge_mod.SPEAK_MAX_MS = 200

bridge = bridge_mod.Bridge(sys.argv[2])
bridge.hello(1, {"config": {"bounds": {"max_speed_pct": 60, "max_op_ms": 250, "low_battery_v": 6.5, "max_tone_ms": 1000, "speech_volume_pct": 50},
                            "pair": {"left": "B", "right": "C"}}})
bridge.command(2, {"device": "speaker", "command": "speak", "args": {"text": "a long phrase"}})
deadline = time.monotonic() + 5
while bridge.tasks and time.monotonic() < deadline:
    bridge.step(bridge.tasks[0])
    time.sleep(0.01)
replies = []
while not bridge.outq.empty():
    replies.append(json.loads(bridge.outq.get().decode("utf-8")))
print(json.dumps({"reply": [r for r in replies if r.get("id") == 2], "still_talking": bridge.talk is not None}))
