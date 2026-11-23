// `--print-add`: the one command that registers this server with Claude Code, written for the computer it runs
// on. Every path in it is absolute, so the registration works from whatever folder Claude Code is started in,
// and quoted for that computer's shells, so a folder with a space in its name works. No I/O.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { pathFrom } from "./config";

/** Flags whose value is a file. `--twin`, `--ev3` and `--ev3dev` may stand alone (the example robot). */
const PATH_FLAGS = [
  "--twin",
  "--world",
  "--ev3",
  "--ev3dev",
  "--config",
  "--ssh-key",
  "--log-file",
  "--lan-key",
  "--page-ext",
];
/** `--lan-cert <cert.pem> <key.pem>`: a flag with two files. */
const TWO_PATH_FLAGS = ["--lan-cert"];
const PLAIN = /^[A-Za-z0-9_@+=:,./-]+$/;

/** One argument as a POSIX shell (sh, bash, zsh) reads it back unchanged. */
function quotePosix(arg: string): string {
  if (!/["\\$`!]/.test(arg)) return `"${arg}"`;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}
/**
 * One argument as PowerShell and cmd.exe both read it back unchanged: double quotes. The characters the two
 * read differently inside double quotes are refused, with the argument named.
 */
function quoteWindows(arg: string): string {
  const bad = arg.match(/["$`%]/);
  if (bad)
    throw new Error(
      `--print-add: ${arg} contains ${bad[0]}, which PowerShell and cmd.exe read differently inside quotes; ` +
        'use folder and file names without " $ ` %',
    );
  return `"${arg}"`;
}

export interface AddCommandInput {
  /** `process.platform` of the computer the command is for. */
  platform: string;
  /** Absolute path of the repository on that computer. */
  repo: string;
  /** The robot arguments, as given after `--print-add`. */
  args: string[];
}

/**
 * `claude mcp add -s user spinecord -- bun "<repo>/apps/local/main.ts" [robots...]` for that computer.
 * On Windows the separator is written `"--"`: PowerShell takes a bare `--` for itself when `claude` is a script
 * (the `claude.ps1` that npm installs), and the robot flags after it are then read as options of `claude`.
 * Quoted, it reaches `claude` from PowerShell and from cmd.exe. `home` is the home folder a leading `~` of a
 * path stands for; tests pass one.
 */
export function addCommand({ platform, repo, args }: AddCommandInput, home: string = homedir()): string {
  const windows = platform === "win32";
  const rules = windows ? win32 : posix;
  const quote = windows ? quoteWindows : quotePosix;
  const out = ["claude", "mcp", "add", "-s", "user", "spinecord", windows ? '"--"' : "--", "bun"];
  out.push(quote(rules.join(repo, "apps", "local", "main.ts")));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (TWO_PATH_FLAGS.includes(arg)) {
      out.push(arg);
      for (let k = 0; k < 2 && args[i + 1] !== undefined && !args[i + 1]!.startsWith("-"); k++)
        out.push(quote(pathFrom(repo, args[++i]!, rules, home)));
    } else if (PATH_FLAGS.includes(flag)) {
      const next = args[i + 1];
      const value = eq !== -1 ? arg.slice(eq + 1) : next !== undefined && !next.startsWith("-") ? args[++i]! : null;
      out.push(flag);
      if (value !== null) out.push(quote(pathFrom(repo, value, rules, home)));
    } else out.push(PLAIN.test(arg) ? arg : quote(arg));
  }
  return out.join(" ");
}
