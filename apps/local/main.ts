// spinecord on one computer: an MCP server over stdio with the runtime and the robots inside this process.
//   claude mcp add -s user spinecord -- bun <repo>/apps/local/main.ts [robots...]
// `bun apps/local/main.ts --print-add [robots...]` prints that command for this computer and starts nothing.
// stdout carries JSON-RPC and nothing else; every log line is one JSON object on stderr.
// When the client goes away (stdin closes) or the process is told to end, every motor is stopped first.
import { log } from "./src/stderr"; // first: it moves console output off stdout
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { HelpAsked, loadConfig, REPO, USAGE, type LocalConfig } from "./src/config";
import { LISTED_TOOLS, buildServer } from "./src/mcp";
import { addCommand } from "./src/print-add";
import { buildFleet, type Fleet } from "./src/sources";

const argv = process.argv.slice(2);
const printAdd = argv.includes("--print-add");
const robotArgs = argv.filter((a) => a !== "--print-add");
let config: LocalConfig;
try {
  // also under --print-add: a command that would not start is not printed
  config = loadConfig(robotArgs);
  if (printAdd) {
    process.stdout.write(`${addCommand({ platform: process.platform, repo: REPO, args: robotArgs })}\n`);
    process.stderr.write(
      "spinecord: run the line above in a terminal. When spinecord is already registered, first run: " +
        "claude mcp remove -s user spinecord\n",
    );
    process.exit(0);
  }
} catch (e) {
  if (e instanceof HelpAsked) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(0);
  }
  process.stderr.write(`spinecord: ${(e as Error).message}\n\n${USAGE}\n`);
  process.exit(2);
}

let fleet: Fleet;
try {
  fleet = await buildFleet(config, { log });
} catch (e) {
  process.stderr.write(`spinecord: ${(e as Error).message}\n`);
  process.exit(1);
}
for (const r of fleet.robots) log("robot", r.listing());
if (fleet.bridge)
  process.stderr.write(
    `spinecord: to lend the EV3, open ${fleet.bridge.url} in Chrome or Edge and press "Connect EV3"\n`,
  );

let ending: Promise<never> | null = null;
/** Stops every motor, says so on stderr, exits. Runs once whatever asks for it. */
function end(why: string, code = 0): Promise<never> {
  ending ??= (async () => {
    log("ending", { why });
    const stopped = await fleet.shutdown();
    for (const s of stopped) log("stopped", s);
    log("exit", { code, why });
    process.exit(code);
  })();
  return ending;
}

const server = buildServer(fleet.robots);
const transport = new StdioServerTransport();
transport.onerror = (e) => log("transport_error", { error: e.message });
await server.connect(transport);
// set after connect(): the server installs its own onclose there
const closed = transport.onclose;
transport.onclose = () => {
  closed?.();
  void end("stdin closed");
};
process.stdin.on("end", () => void end("stdin ended"));
process.stdin.on("close", () => void end("stdin closed"));
process.on("SIGINT", () => void end("SIGINT"));
process.on("SIGTERM", () => void end("SIGTERM"));
process.on("SIGHUP", () => void end("SIGHUP"));
log("ready", { robots: fleet.robots.map((r) => r.id), tools: LISTED_TOOLS.length });
