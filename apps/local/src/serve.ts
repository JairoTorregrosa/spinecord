// The server of main.ts once its config is loaded: the fleet, MCP over stdio, and the stop of every motor when
// the client goes away or the process is told to end. Resolves once the server is ready; the process ends
// through `end`.
import { log, logTo } from "./stderr"; // first: it moves console output off stdout
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { LocalConfig } from "./config";
import { LISTED_TOOLS, buildServer } from "./mcp";
import { buildFleet, type Fleet, type FleetOptions } from "./sources";

/** `fleetOptions`: what buildFleet takes besides `log`. main.ts passes none. */
export async function serve(config: LocalConfig, fleetOptions: Omit<FleetOptions, "log"> = {}): Promise<void> {
  let fleet: Fleet;
  try {
    if (config.logFile !== undefined) logTo(config.logFile);
    fleet = await buildFleet(config, { ...fleetOptions, log });
  } catch (e) {
    process.stderr.write(`spinecord: ${(e as Error).message}\n`);
    process.exit(1);
  }
  for (const r of fleet.robots) log("robot", r.listing());
  if (fleet.bridge)
    process.stderr.write(
      `spinecord: to lend the EV3, open ${fleet.bridge.url} in Chrome or Edge and press "Connect EV3"\n`,
    );

  if (fleet.pages)
    process.stderr.write(
      `spinecord: pages join the robots on ${fleet.pages.url} (this computer only); list_robots says how in \`join\`\n`,
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
}
