// One real run of a page mission: `bun agent.ts` with Claude, the twin, and the fake page of apps/local in place of
// the browser. It costs money (the --max-usd given here) and is not part of `bun test`.
//
//   bun test/real-run.ts <mission file> <transcript> [--press] [--max-usd 0.30] [--say "haz tu misión ahora"]
//
// It reads the program's output, joins the fake page to the link the program prints, writes one chat line once
// the page has joined, and "bye" after the first turn. --press presses the page's button 1 every 2 s during the
// turn (a visitor at the door). It prints the program's output, then what the page was told to say and show.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FAKE_DEVICES, FAKE_SCREEN, fakePage, type FakePage } from "../../../apps/local/test/pages.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1]! : fallback;
};
const press = args.includes("--press") ? (args.splice(args.indexOf("--press"), 1), true) : false;
const maxUsd = option("--max-usd", "0.30");
const say = option("--say", "haz tu misión ahora");
const [mission, transcript = ""] = args;
if (!mission)
  throw new Error("usage: bun test/real-run.ts <mission file> <transcript> [--press] [--max-usd n] [--say text]");

const HERE = resolve(import.meta.dir, "..");
const child = Bun.spawn(
  [process.execPath, join(HERE, "agent.ts"), "--mission", resolve(mission), "--max-usd", maxUsd],
  {
    cwd: HERE,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  },
);
const write = (line: string) => {
  process.stdout.write(`[harness writes] ${line}\n`);
  child.stdin.write(`${line}\n`);
};

let page: FakePage | null = null;
let presser: ReturnType<typeof setInterval> | undefined;
const deadline = setTimeout(() => {
  process.stdout.write("[harness] 240 s passed: ending\n");
  child.kill("SIGINT");
}, 240_000);

const decoder = new TextDecoder();
let rest = "";
for await (const chunk of child.stdout) {
  const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
  rest = lines.pop() ?? "";
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
    const link = line.trim().match(/^(http:\/\/127\.0\.0\.1:\d+\/)#robot=([^&]+)/);
    if (link && !page) {
      page = await fakePage({
        url: link[1]!,
        robot: decodeURIComponent(link[2]!),
        transcript,
        frame: new Uint8Array(readFileSync(join(import.meta.dir, "door.jpg"))),
        devices: [...FAKE_DEVICES, FAKE_SCREEN],
      });
    }
    if (line.startsWith("The page ") && line.includes(" joined ")) {
      write(say);
      if (press) presser = setInterval(() => (page!.press(), setTimeout(() => page!.release(), 300)), 2000);
    }
    if (line.includes("[turn 1:")) {
      clearInterval(presser);
      write("bye");
    }
  }
}
clearTimeout(deadline);
const code = await child.exited;
process.stdout.write(`[harness] exit ${code}\n[harness] the page said: ${JSON.stringify(page?.spoken ?? [])}\n`);
process.stdout.write(`[harness] the page showed: ${JSON.stringify(page?.shown ?? [])}\n`);
page?.close();
