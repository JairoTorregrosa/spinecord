"""The golden vectors of the loop law through the bridge's port of it (law_start, law_set, law_step).

usage: law_check.py <bridge file> <loop-golden.json>
Runs every case from its `plan`, tick by tick, as packages/protocol/loop.test.ts runs loop.ts, and compares with
the same tolerances: outputs within 1e-9, each signal's value, integral and derivative within 1e-9 relative,
guard and end on exactly the tick that has them. Prints one JSON line: how many cases and ticks ran, every
mismatch, and per case what the bridge's statistics (stats_record, stats_take) collected over all its ticks, for
the caller to compare with loop.ts's own. Runs on Python 3.5 and later.
"""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("ev3dev_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

with open(sys.argv[2]) as f:
    golden = json.load(f)

failures = []
ticks_run = 0
stats = {}


def close(got, want, relative):
    scale = max(1.0, abs(want)) if relative else 1.0
    return abs(got - want) <= 1e-9 * scale


for case in golden["cases"]:
    plan = case["plan"]
    names = [s["name"] for s in plan["signals"]]
    st = bridge.law_start(plan)
    window = bridge.stats_start(st)
    for k, tick in enumerate(case["ticks"]):
        where = "%s: tick %d" % (case["name"], k)
        if "set" in tick:
            bridge.law_set(st, tick["set"]["params"], tick["set"].get("ramp_ms", 0))
        inputs = [tick["inputs"].get(n) for n in names]
        outputs, end = bridge.law_step(st, inputs, tick["dt"])
        bridge.stats_record(window, st)
        ticks_run += 1
        want = tick["expect"]
        if len(outputs) != len(want["outputs"]):
            failures.append("%s: %d outputs, expected %d" % (where, len(outputs), len(want["outputs"])))
        for i, u in enumerate(outputs):
            if i < len(want["outputs"]) and not close(u, want["outputs"][i], False):
                failures.append("%s output %d: %r, expected %r" % (where, i, u, want["outputs"][i]))
        for i, n in enumerate(names):
            for part in ("value", "integral", "derivative"):
                got = st["signals"][i][part]
                exp = want["signals"][n][part]
                if not close(got, exp, True):
                    failures.append("%s signal %s %s: %r, expected %r" % (where, n, part, got, exp))
        guard = None if end is None else end.get("guard")
        reason = None if end is None else end["reason"]
        exp_end = want.get("end")
        if reason != (None if exp_end is None else exp_end["reason"]) or guard != want.get("guard"):
            failures.append("%s: end %s guard %s, expected end %s guard %s" % (where, json.dumps(reason), json.dumps(guard), json.dumps(exp_end), json.dumps(want.get("guard"))))
    stats[case["name"]] = bridge.stats_take(window, st)

print(json.dumps({"cases": len(golden["cases"]), "ticks": ticks_run, "failures": failures, "stats": stats}))
sys.exit(1 if failures else 0)
