// Eyes, ears and voice, without Claude: the page listener the program starts, the link it prints and its wait
// for the join, then each page mission's tools in the order its file gives them, against the twin and the fake
// page client of apps/local (scripted transcripts, a test frame). Nothing here calls Claude.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer, type TestServer, until } from "../../../apps/local/test/client.ts";
import { FAKE_DEVICES, FAKE_SCREEN, fakePage, type FakePage } from "../../../apps/local/test/pages.ts";
import { buildOptions, instructions, lendPage, SERVER, SPINECORD_MAIN } from "../agent.ts";
import {
  joinedPage,
  pageLink,
  pageListener,
  parseArgs,
  parseMission,
  readMission,
  SECTIONS,
  serverPath,
  ServerLog,
  withPages,
} from "../setup.ts";

const HERE = resolve(import.meta.dir, "..");
const MISSIONS = join(HERE, "missions");
const FRAME = new Uint8Array(readFileSync(join(import.meta.dir, "door.jpg")));
const PAGE_MISSIONS = ["pill-voice.md", "door.md", "voice-commands.md"];

const open: { servers: TestServer[]; pages: FakePage[]; files: string[] } = { servers: [], pages: [], files: [] };
afterEach(async () => {
  for (const p of open.pages.splice(0)) p.close();
  await Promise.all(open.servers.splice(0).map((s) => s.closeStdin()));
  for (const f of open.files.splice(0)) rmSync(f, { force: true });
});

let n = 0;
const tempLog = () => {
  const file = join(tmpdir(), `spinecord-assistant-test-${process.pid}-${++n}.jsonl`);
  open.files.push(file);
  return file;
};

/** The server exactly as the SDK would start it for this mission: the args of buildOptions' spinecord entry. */
async function serverFor(missionFile: string, robotFlags: string[] = []) {
  const mission = readMission(join(MISSIONS, missionFile));
  const paged = withPages(robotFlags, tempLog());
  const options = buildOptions(mission, { ...parseArgs([]), robotFlags: [...paged.robotFlags, "--page-port", "0"] });
  const entry = options.mcpServers![SERVER] as { command: string; args: string[] };
  expect(entry.args[0]).toBe(SPINECORD_MAIN);
  // opened before the server starts, as main() does: it reads only what the server writes from then on
  const log = new ServerLog(paged.logFile);
  const server = await startServer(entry.args.slice(1));
  open.servers.push(server);
  return { mission, server, log, logFile: paged.logFile };
}

/** lendPage with a page that never joins and a person who never types, unless the test says otherwise. */
function lend(log: ServerLog, lang: string, o: { typed?: Promise<unknown>; stopped?: Promise<unknown> } = {}) {
  const printed: string[] = [];
  const result = lendPage({
    log,
    lang,
    name: "Luz",
    print: (line) => printed.push(line),
    typed: o.typed ?? new Promise(() => {}),
    stopped: o.stopped ?? new Promise(() => {}),
    listenerWaitMs: 10_000,
  });
  return { printed, result };
}

const linkIn = (printed: string[]) => printed.find((l) => l.trim().startsWith("http"))!.trim();

describe("a mission says it needs a page", () => {
  test("the three page missions parse, with the language of their Page line", () => {
    for (const file of PAGE_MISSIONS) {
      const mission = readMission(join(MISSIONS, file));
      expect(mission.page).toEqual({ lang: "es-ES" });
      for (const title of SECTIONS) expect(mission.text).toContain(`## ${title}`);
    }
  });

  test("a file without a Page line has no page", () => {
    for (const file of ["guard.md", "plant.md", "waiter.md"]) expect(readMission(join(MISSIONS, file)).page).toBeNull();
    expect(readMission(join(HERE, "assistant.md")).page).toBeNull();
  });

  test("a Page line without a language fails with the file and the line", () => {
    const text = (line: string) =>
      SECTIONS.map((title) => `## ${title}\n${title === "My robot" ? `${line}\nwords` : "words"}`).join("\n");
    expect(() => parseMission(text("Page:"), "mine.md")).toThrow(/mine\.md: the line "Page:" under "## My robot"/);
    expect(() => parseMission(text("Page: Spanish please"), "mine.md")).toThrow(/for example "Page: es-ES"/);
    expect(parseMission(text("page: es-MX"), "mine.md").page).toEqual({ lang: "es-MX" });
  });

  test("the system prompt carries the three habits of a page", () => {
    const prompt = instructions(readMission(join(MISSIONS, "pill-voice.md")));
    expect(prompt).toContain("Read what a page lends before you use it");
    expect(prompt).toContain("Speak short");
    expect(prompt).toContain("Never keep the camera or the microphone on without need");
  });
});

describe("the page listener", () => {
  test("no robot flags: the twin and the page listener; robot flags gain --pages; a log the person gave is kept", () => {
    expect(withPages([], "/t/own.jsonl")).toEqual({
      robotFlags: ["--twin", "--pages", "--log-file", "/t/own.jsonl"],
      logFile: "/t/own.jsonl",
    });
    expect(withPages(["--ev3"], "/t/own.jsonl").robotFlags).toEqual(["--ev3", "--pages", "--log-file", "/t/own.jsonl"]);
    expect(withPages(["--twin", "--pages", "my.json"], "/t/own.jsonl").robotFlags).toEqual([
      "--twin",
      "--pages",
      "my.json",
      "--log-file",
      "/t/own.jsonl",
    ]);
    expect(withPages(["--config", "c.json"], "/t/own.jsonl").robotFlags).toEqual([
      "--config",
      "c.json",
      "--log-file",
      "/t/own.jsonl",
    ]);
    const kept = withPages(["--ev3", "--log-file", "robot.log"], "/t/own.jsonl");
    expect(kept.robotFlags).toEqual(["--ev3", "--log-file", "robot.log", "--pages"]);
    expect(kept.logFile).toBe(serverPath("robot.log"));
    expect(kept.logFile).toBe(resolve(HERE, "..", "..", "robot.log"));
  });

  test("the SDK starts the server with the page flags", () => {
    const mission = readMission(join(MISSIONS, "door.md"));
    const paged = withPages([], "/t/own.jsonl");
    const entry = buildOptions(mission, { ...parseArgs([]), robotFlags: paged.robotFlags }).mcpServers![SERVER] as {
      args: string[];
    };
    expect(entry.args).toEqual([SPINECORD_MAIN, "--twin", "--pages", "--log-file", "/t/own.jsonl"]);
  });

  test("the program prints the join link and waits until the page has joined", async () => {
    const { server, log } = await serverFor("pill-voice.md");
    const { printed, result } = lend(log, "es-ES");
    await until("the link", () => printed.some((l) => l.trim().startsWith("http")), 10_000);
    const link = linkIn(printed);
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#robot=r1-sim&lang=es-ES$/);
    expect(printed.join("\n")).toContain('tap "Lend this device"');
    // the link opens the page the server serves
    expect(await (await fetch(link)).text()).toContain('name="spinecord-token"');
    let settled = false;
    void result.then(() => (settled = true));
    await Bun.sleep(400);
    expect(settled).toBe(false); // no page yet: still waiting
    const page = await fakePage({ url: link.split("#")[0]!, robot: "r1-sim", transcript: "ya" });
    open.pages.push(page);
    expect(await result).toBe("joined");
    expect(printed.at(-1)).toBe("The page desk joined r1-sim: camera, microphone, speaker, touch_panel.");
    const listed = await server.tool("list_robots");
    expect((listed.envelope as any).data.robots.map((r: { id: string }) => r.id)).toEqual(["r1-sim", "pages"]);
  }, 20_000);

  test("a typed line ends the wait without a page; a stop ends it too", async () => {
    const { log } = await serverFor("door.md");
    let type!: () => void;
    const typed = lend(log, "es-ES", { typed: new Promise<void>((r) => (type = r)) });
    await until("the link", () => typed.printed.length >= 3, 10_000);
    type();
    expect(await typed.result).toBe("typed");
    expect(typed.printed.at(-1)).toContain("Going on without a page");
    const stopped = lend(new ServerLog(log.path), "es-ES", { stopped: Promise.resolve() });
    expect(await stopped.result).toBe("stopped");
  }, 20_000);

  test("a log file of an earlier run is skipped: only lines written after the start count", () => {
    const file = tempLog();
    writeFileSync(
      file,
      `${JSON.stringify({ ev: "page", robot_id: "r1-sim", name: "old", to: "active", kinds: [] })}\n`,
    );
    const log = new ServerLog(file);
    expect(joinedPage(log.read(), "r1-sim")).toBeNull();
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}${JSON.stringify({ ev: "page", robot_id: "r1-sim", name: "desk", to: "active", kinds: ["camera"] })}\n`,
    );
    expect(joinedPage(log.read(), "r1-sim")).toEqual({ name: "desk", kinds: ["camera"] });
  });

  test("the page joins the robot with a body; with none, the robot without one", () => {
    const join = (port: number, id: string) =>
      `On this computer open http://127.0.0.1:${port}/ in Chrome or Edge and lend robot ${id} the devices of that page.`;
    const both = [
      { ev: "robot", id: "pages", backend: "page", join: join(9, "pages") },
      { ev: "robot", id: "r1", backend: "ev3", join: join(9, "r1") },
    ];
    expect(pageListener(both)).toEqual({ url: "http://127.0.0.1:9/", robot: "r1" });
    expect(pageListener(both.slice(0, 1))).toEqual({ url: "http://127.0.0.1:9/", robot: "pages" });
    expect(pageListener([{ ev: "robot", id: "r1", backend: "ev3", join: null }])).toBeNull();
    expect(pageLink({ url: "http://127.0.0.1:9/", robot: "r1" }, "es-MX")).toBe(
      "http://127.0.0.1:9/#robot=r1&lang=es-MX",
    );
  });
});

// ---------------------------------------------------------------- the missions, step by step

const R = "r1-sim";

/** The server of a mission with a fake page joined to the twin, as the program leaves it after lendPage. */
async function missionRig(file: string, page: { transcript?: string; screen?: boolean }) {
  const rig = await serverFor(file);
  const { printed, result } = lend(rig.log, rig.mission.page!.lang);
  await until("the link", () => printed.some((l) => l.trim().startsWith("http")), 10_000);
  const fake = await fakePage({
    url: linkIn(printed).split("#")[0]!,
    robot: R,
    transcript: page.transcript ?? "",
    frame: FRAME,
    devices: page.screen ? [...FAKE_DEVICES, FAKE_SCREEN] : FAKE_DEVICES,
  });
  open.pages.push(fake);
  expect(await result).toBe("joined");
  const s = rig.server;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await s.tool(name, { robot_id: R, ...args });
    if (!out.envelope.ok) throw new Error(`${name}: ${JSON.stringify(out.envelope.error)}`);
    return { content: out.content, data: out.envelope.data as any };
  };
  // habit 1: read what the page lends before using it
  const robot = await tool("describe_robot");
  const devices = (robot.data.devices as { id: string }[]).map((d) => d.id);
  const speak = (text: string) => tool("command_device", { device: "desk.speaker", command: "speak", args: { text } });
  const listen = async (expect: string[]) => {
    await tool("command_device", { device: "desk.mic", command: "listen", args: { max_ms: 10_000, expect } });
    const read = await tool("read_device", { device: "desk.mic", channels: ["last_match"] });
    return read.data.readings[0].value as string;
  };
  const distance = async () =>
    (await tool("read_device", { device: "distance", channels: ["distance_cm"] })).data.readings[0].value as number;
  return { s, fake, tool, devices, speak, listen, distance };
}

/** pill-voice.md, "My mission": drive to the chair, remind, listen, act on last_match; no answer repeats once. */
async function pillReminder(rig: Awaited<ReturnType<typeof missionRig>>) {
  const { tool, speak, listen, distance } = rig;
  // drive to about 15 cm before the chair, at most 40 cm a move, speed 30 or less
  for (let moves = 0; moves < 5 && (await distance()) > 17; moves++)
    await tool("drive", {
      distance_cm: Math.min(40, (await distance()) - 15),
      speed_pct: 30,
      until: { device: "distance", channel: "distance_cm", op: "lte", value: 15 },
    });
  const expected = ["ya me la tomé", "ya", "después"];
  for (let attempt = 0; attempt < 2; attempt++) {
    await speak("Carmen, es hora de tu pastilla azul.");
    const match = await listen(expected);
    if (match === "ya me la tomé" || match === "ya") {
      await speak("Muy bien, Carmen.");
      await tool("command_device", { device: "desk.screen", command: "face", args: { expression: "happy" } });
      return "taken";
    }
    if (match === "después") {
      await speak("Vuelvo en diez minutos.");
      return "later";
    }
  }
  await speak("Vuelvo en un rato.");
  return "no answer";
}

describe("the pill reminder that speaks and listens (pill-voice.md)", () => {
  test('"ya me la tomé": the robot drives to the chair, speaks, listens, and last_match ends it with a happy face', async () => {
    const rig = await missionRig("pill-voice.md", { transcript: "Ya me la tomé, gracias", screen: true });
    expect(rig.devices).toEqual(expect.arrayContaining(["desk.mic", "desk.speaker", "desk.screen", "desk.camera"]));
    const before = await rig.distance();
    expect(await pillReminder(rig)).toBe("taken");
    const after = await rig.distance();
    expect(before - after).toBeGreaterThan(10); // it drove toward the chair
    expect(after).toBeLessThan(20);
    expect(rig.fake.spoken).toEqual(["Carmen, es hora de tu pastilla azul.", "Muy bien, Carmen."]);
    expect(rig.fake.shown).toEqual(["face happy"]);
  }, 30_000);

  test('"después": it says it comes back in ten minutes', async () => {
    const rig = await missionRig("pill-voice.md", { transcript: "después", screen: true });
    expect(await pillReminder(rig)).toBe("later");
    expect(rig.fake.spoken.at(-1)).toBe("Vuelvo en diez minutos.");
  }, 30_000);

  test("no answer: it repeats once, then says it will come back", async () => {
    const rig = await missionRig("pill-voice.md", { transcript: "", screen: true });
    expect(await pillReminder(rig)).toBe("no answer");
    expect(rig.fake.spoken).toEqual([
      "Carmen, es hora de tu pastilla azul.",
      "Carmen, es hora de tu pastilla azul.",
      "Vuelvo en un rato.",
    ]);
    expect(rig.fake.shown).toEqual([]);
  }, 30_000);
});

describe("the door watcher (door.md)", () => {
  test("a press of the page's button 1 meets the watch; one frame, a greeting and a face", async () => {
    const rig = await missionRig("door.md", { screen: true });
    const { tool, fake } = rig;
    await tool("read_device", { device: "desk.touch", channels: ["b1_presses"] });
    setTimeout(() => fake.press(), 300);
    const watch = await tool("wait_until", {
      timeout_ms: 8000,
      condition: {
        any: [
          { device: "distance", channel: "distance_cm", op: "lt", value: 30 },
          { device: "desk.touch", channel: "b1_presses", op: "changed" },
        ],
      },
    });
    expect(watch.data.met).toBe(true);
    const frame = await tool("read_device", { device: "desk.camera", channels: ["frame"] });
    expect(frame.content[1]).toEqual({
      type: "image",
      data: Buffer.from(FRAME).toString("base64"),
      mimeType: "image/jpeg",
    });
    await rig.speak("Hola, ya te atienden.");
    await tool("command_device", { device: "desk.screen", command: "face", args: { expression: "happy" } });
    expect(fake.spoken).toEqual(["Hola, ya te atienden."]);
    expect(fake.shown).toEqual(["face happy"]);
  }, 30_000);

  test("nobody: the watch times out and the robot stays where it is", async () => {
    const rig = await missionRig("door.md", { screen: true });
    const before = await rig.distance();
    const watch = await rig.tool("wait_until", {
      timeout_ms: 600,
      condition: { device: "desk.touch", channel: "b1_presses", op: "changed" },
    });
    expect(watch.data.met).toBe(false);
    expect(Math.abs((await rig.distance()) - before)).toBeLessThan(2);
    expect(rig.fake.spoken).toEqual([]);
  }, 30_000);
});

/** voice-commands.md, "My mission": one order, mapped to a small move; "para" first and always. */
async function oneOrder(rig: Awaited<ReturnType<typeof missionRig>>) {
  const { tool, speak, listen } = rig;
  const match = await listen(["para", "adelante", "atrás", "izquierda", "derecha"]);
  if (match === "para") {
    await tool("stop");
    await speak("Me detengo.");
  } else if (match === "adelante") await tool("drive", { distance_cm: 10, speed_pct: 20 });
  else if (match === "atrás") await tool("drive", { distance_cm: -10, speed_pct: 20 });
  else if (match === "izquierda") await tool("turn", { angle_deg: 45, speed_pct: 20 });
  else if (match === "derecha") await tool("turn", { angle_deg: -45, speed_pct: 20 });
  else await speak("No entendí.");
  if (["adelante", "atrás", "izquierda", "derecha"].includes(match)) await speak("Listo.");
  return match;
}

describe("the voice-command robot (voice-commands.md)", () => {
  test('"adelante": a 10 cm step forward, then "Listo"', async () => {
    const rig = await missionRig("voice-commands.md", { transcript: "adelante" });
    const before = await rig.distance();
    expect(await oneOrder(rig)).toBe("adelante");
    const moved = before - (await rig.distance());
    expect(moved).toBeGreaterThan(7);
    expect(moved).toBeLessThan(13);
    expect(rig.fake.spoken).toEqual(["Listo."]);
  }, 30_000);

  test('"ve para adelante" matches "para" first: the robot stops and does not move', async () => {
    const rig = await missionRig("voice-commands.md", { transcript: "ve para adelante" });
    const before = await rig.distance();
    expect(await oneOrder(rig)).toBe("para");
    expect(Math.abs((await rig.distance()) - before)).toBeLessThan(2);
    expect(rig.fake.spoken).toEqual(["Me detengo."]);
  }, 30_000);

  test("a phrase not in the list: no move, and it says so", async () => {
    const rig = await missionRig("voice-commands.md", { transcript: "cántame algo" });
    const before = await rig.distance();
    expect(await oneOrder(rig)).toBe("");
    expect(Math.abs((await rig.distance()) - before)).toBeLessThan(2);
    expect(rig.fake.spoken).toEqual(["No entendí."]);
  }, 30_000);
});
