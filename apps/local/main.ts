// spinecord on one computer: an MCP server over stdio with the runtime and the robots inside this process.
//   claude mcp add -s user spinecord -- bun <repo>/apps/local/main.ts [robots...]
// `bun apps/local/main.ts --print-add [robots...]` prints that command for this computer and starts nothing.
// stdout carries JSON-RPC and nothing else; every log line is one JSON object on stderr, and `--log-file <path>`
// appends the same lines to a file.
// When the client goes away (stdin closes) or the process is told to end, every motor is stopped first.
import "./src/stderr"; // first: it moves console output off stdout
import { HelpAsked, loadConfig, REPO, USAGE, type LocalConfig } from "./src/config";
import { addCommand } from "./src/print-add";
import { serve } from "./src/serve";

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

await serve(config);
