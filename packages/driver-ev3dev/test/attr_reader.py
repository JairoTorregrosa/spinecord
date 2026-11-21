"""Reader half of the fake-brick write test in provider.test.ts.

usage: attr_reader.py <bridge file> <attribute file> <growth>
Reads the attribute over and over with the bridge's own read_int, as the bridge does while the test
rewrites it, until the value has grown by <growth> since the first read. Prints one JSON line: how
many reads worked, how many failed (an empty or missing file, a refused open) and the first errors.
"""
import importlib.util
import json
import sys
import time

spec = importlib.util.spec_from_file_location("ev3dev_bridge", sys.argv[1])
bridge_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_mod)

path, growth = sys.argv[2], int(sys.argv[3])
deadline = time.monotonic() + 20
first = None
reads = 0
failed = 0
errors = []
timed_out = False
while True:
    try:
        value = bridge_mod.read_int(path)
        reads += 1
        if first is None:
            first = value
        if value - first >= growth:
            break
    except Exception as e:
        failed += 1
        if len(errors) < 5:
            errors.append("%s: %s" % (type(e).__name__, e))
    if time.monotonic() > deadline:
        timed_out = True
        break
print(json.dumps({"reads": reads, "failed": failed, "errors": errors, "timed_out": timed_out}))
