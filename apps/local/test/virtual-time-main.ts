// main.ts with every twin on one virtual clock (the runtime's FakeClock): the robot moves in simulated time,
// which advances as fast as the process runs, so a loaded machine slows a test without changing what the robot
// does. Same arguments, same stdio, same stop at exit as main.ts.
import "../src/stderr"; // first: it moves console output off stdout
import { FakeClock } from "../../../packages/runtime/clock";
import { loadConfig } from "../src/config";
import { serve } from "../src/serve";

await serve(loadConfig(process.argv.slice(2)), { clock: new FakeClock() });
