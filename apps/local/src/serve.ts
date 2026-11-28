// The server of main.ts once its config is loaded: the fleet, MCP over stdio, and the stop of every motor when
// the client goes away or the process is told to end. Resolves once the server is ready; the process ends
// through `end`.
import { log, logTo } from "./stderr"; // first: it moves console output off stdout
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { mapNameMismatches, type LocalConfig } from "./config";
import { LISTED_TOOLS, buildServer } from "./mcp";
import { linksText } from "./pages";
import { buildFleet, type Fleet, type FleetOptions } from "./sources";
import { buildViewPage } from "../../twin-view/view-build";
import { serveView, type ViewServer } from "./view";
import { chatSdkMissing } from "./chat-sdk";

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
  let view: ViewServer | null = null;
  let chat: import("./chat").Chat | null = null;
  if (config.view) {
    try {
      const twins = fleet.robots
        .filter((r) => fleet.bricks.has(r.id))
        .map((r) => ({ id: r.id, brick: fleet.bricks.get(r.id)!, sim: fleet.sims.get(r.id)!, robot: r }));
      // --chat (experimental): loaded only with the flag; its MCP server is made once the view watches the calls
      if (config.view.chat) {
        const missing = chatSdkMissing();
        if (missing) throw new Error(missing);
        const { createChat } = await import("./chat");
        const robotId = twins[0]!.id;
        chat = createChat({ robots: fleet.robots, robotId, config: config.view.chat, log }, () =>
          buildServer(fleet.robots, view ?? undefined),
        );
      }
      view = serveView(twins, config.view.port, { page: await buildViewPage(), log, ...(chat ? { chat } : {}) });
    } catch (e) {
      await fleet.shutdown();
      process.stderr.write(`spinecord: ${(e as Error).message}\n`);
      process.exit(1);
    }
  }
  for (const r of fleet.robots) log("robot", r.listing());
  for (const s of config.robots)
    if (s.source === "twin")
      for (const m of mapNameMismatches(s.worlds ?? {}))
        log("map_name_differs", {
          robot_id: s.id,
          ...m,
          why: `use_map takes "${m.map}" (the file name); the world inside says "${m.name}", which measured.world reports`,
        });
  if (view) {
    process.stderr.write(`spinecord: the 3D view of the twins is on ${view.url}: open it in a browser\n`);
    log("view", { url: view.url });
  }
  void chat?.start();
  if (fleet.bridge)
    process.stderr.write(
      `spinecord: to lend the EV3, open ${fleet.bridge.url} in Chrome or Edge and press "Connect EV3"\n`,
    );

  if (fleet.pages) {
    const p = fleet.pages;
    process.stderr.write(
      p.lanUrl || p.tunnelUrl
        ? `spinecord: pages join the robots on ${p.url} (this computer)${p.lanUrl ? `, on ${p.lanUrl} (this network)` : ""}${p.tunnelUrl ? `, and through the tunnel that forwards to ${p.tunnelUrl}` : ""}; list_robots says how in \`join\`\n`
        : `spinecord: pages join the robots on ${p.url} (this computer only); list_robots says how in \`join\`\n`,
    );
    if (fleet.lan)
      process.stderr.write(
        `spinecord: --lan listens on ${fleet.lan.address} (${fleet.lan.interface}) as ${fleet.lan.host}, certificate from ${fleet.lan.source}. ${fleet.lan.nameCheck.ok ? "" : "WARNING: "}${fleet.lan.nameCheck.text}.\n` +
          (process.platform === "win32"
            ? "spinecord: Windows may ask whether bun may accept connections on this network: allow it on private networks, or phones cannot join.\n"
            : ""),
      );
    if (p.tunnelUrl)
      process.stderr.write(
        `spinecord: --page-origin: every frame, transcript and command of a page that joins through the tunnel crosses the tunnel's operator and the internet.\n`,
      );
    // the links carry the token: written to stderr only, never through log() and so never to --log-file
    const links = p.links();
    if (links.length)
      process.stderr.write(
        `spinecord: to add a phone, scan a code below or the one at ${p.consoleUrl}; each link carries the pairing token of this start.\n${linksText(links)}`,
      );
  }

  let ending: Promise<never> | null = null;
  /** Stops every motor, says so on stderr, exits. Runs once whatever asks for it. */
  function end(why: string, code = 0): Promise<never> {
    ending ??= (async () => {
      log("ending", { why });
      chat?.close();
      const stopped = await fleet.shutdown();
      view?.stop();
      for (const s of stopped) log("stopped", s);
      log("exit", { code, why });
      process.exit(code);
    })();
    return ending;
  }

  const server = buildServer(fleet.robots, view ?? undefined);
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
  log("ready", { robots: fleet.robots.map((r) => r.id), tools: LISTED_TOOLS.length, clock: fleet.clock });
}
