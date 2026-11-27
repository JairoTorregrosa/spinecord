// spinecord on one computer: an MCP server over stdio with the runtime and the robots inside this process.
//   claude mcp add -s local spinecord -- bun <repo>/apps/local/main.ts [robots...], in the folder Claude Code starts in
// `bun apps/local/main.ts --print-add [robots...]` prints that command for this computer and starts nothing.
// `bun apps/local/main.ts --doctor [robots...] [--assistant]` checks this computer for those robots (src/doctor.ts).
// stdout carries JSON-RPC and nothing else; every log line is one JSON object on stderr, and `--log-file <path>`
// appends the same lines to a file.
// When the client goes away (stdin closes) or the process is told to end, every motor is stopped first.
import "./src/stderr"; // first: it moves console output off stdout
import { HelpAsked, loadConfig, REPO, USAGE, type LocalConfig } from "./src/config";
import { addCommand } from "./src/print-add";
import { serve } from "./src/serve";

const argv = process.argv.slice(2);
if (argv.includes("--doctor") && !argv.includes("--help")) {
  if (argv.includes("--print-add")) {
    process.stderr.write("spinecord: --doctor and --print-add: run one at a time\n");
    process.exit(2);
  }
  const { doctorMain } = await import("./src/doctor");
  process.exit(await doctorMain(argv.filter((a) => a !== "--doctor")));
}
const printAdd = argv.includes("--print-add");
const robotArgs = argv.filter((a) => a !== "--print-add");
let config: LocalConfig;
try {
  // also under --print-add: a command that would not start is not printed
  config = loadConfig(robotArgs);
  if (printAdd) {
    process.stdout.write(`${addCommand({ platform: process.platform, repo: REPO, args: robotArgs })}\n`);
    process.stderr.write(
      "spinecord: run the line above in a terminal, in the folder you start Claude Code in (local scope: only " +
        "sessions opened there start these robots). When spinecord is already registered there, first run: " +
        "claude mcp remove -s local spinecord\n",
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

await serve(config);
