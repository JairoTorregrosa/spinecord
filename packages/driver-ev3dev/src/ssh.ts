// Transports for the ev3dev bridge that need a process: any local command (tests, a bridge run by
// hand) and the system `ssh` client. Uses node:child_process with an argument array and no shell,
// so it behaves the same with OpenSSH on macOS, Linux and Windows 10+ (ssh.exe ships with Windows).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "../../protocol/types";
import type { LineTransport } from "./provider";

/** The bridge file shipped with this package. */
export const BRIDGE_FILE = fileURLToPath(new URL("../bridge/ev3dev_bridge.py", import.meta.url));
/** Where installBridge() puts it on the brick, relative to the ssh user's home. */
export const DEFAULT_REMOTE_PATH = "~/spinecord/ev3dev_bridge.py";

/**
 * What a process's stderr adds to the reason its link closed, for a model and a person: the bridge's own lines
 * (`ev3dev_bridge: ...`) when it wrote any, else what was written (ssh's own message), without the dump an
 * interpreter prints when it aborts (a fatal error and its thread list, a traceback).
 */
export function closeDetail(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const own = lines.filter((l) => l.startsWith("ev3dev_bridge:"));
  if (own.length) return own.join(" ");
  const dump = lines.findIndex((l) => /^(Fatal Python error|Traceback \(most recent call last\))/.test(l));
  return (dump < 0 ? lines : lines.slice(0, dump)).join(" ").trim();
}

/** Runs a command and exchanges text lines with it over stdin/stdout. stderr is kept for the close reason. */
export class ProcessLineTransport implements LineTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineCbs: ((line: string) => void)[] = [];
  private closeCbs: ((reason: string) => void)[] = [];
  private stderr = "";
  private exited: Promise<void> = Promise.resolve();

  constructor(
    private readonly cmd: string,
    private readonly args: string[],
    private readonly opts: { env?: Record<string, string | undefined>; label?: string } = {},
  ) {}

  open(): Promise<void> {
    if (this.child) return Promise.resolve();
    const label = this.opts.label ?? this.cmd;
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.cmd, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
      });
      this.child = child;
      this.stderr = "";
      let started = false;
      let done = false;
      let buf = "";
      let markExited = () => {};
      this.exited = new Promise<void>((r) => {
        markExited = r;
      });
      const finish = (reason: string) => {
        if (done) return;
        done = true;
        if (this.child === child) this.child = null;
        markExited();
        if (!started) {
          reject(new Error(reason));
          return;
        }
        for (const cb of this.closeCbs) cb(reason);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line) for (const cb of this.lineCbs) cb(line);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-2000);
      });
      child.stdin.on("error", () => {}); // a dead peer is reported by `close`
      child.once("spawn", () => {
        started = true;
        resolve();
      });
      child.once("error", (e: NodeJS.ErrnoException) =>
        finish(e.code === "ENOENT" ? `${label}: program "${this.cmd}" not found on PATH` : `${label}: ${e.message}`),
      );
      child.once("close", (code, sig) =>
        finish(
          `${label} exited (${sig ?? `code ${code}`})${closeDetail(this.stderr) ? `: ${closeDetail(this.stderr)}` : ""}`,
        ),
      );
    });
  }

  send(line: string): void {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error(`${this.opts.label ?? this.cmd}: not open`);
    child.stdin.write(`${line}\n`);
  }
  onLine(cb: (line: string) => void): void {
    this.lineCbs.push(cb);
  }
  onClose(cb: (reason: string) => void): void {
    this.closeCbs.push(cb);
  }

  /** Closes stdin (the bridge then brakes and exits) and waits for the process; kills it after 2 s. */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SshOptions {
  host: string;
  /** Default 22. */
  port?: number;
  user: string;
  /** Path of a private key file (ssh -i). Without it ssh uses its agent and default keys. */
  identityFile?: string;
  /** Extra `-o` options, each as "Name=value". */
  options?: string[];
  /** Default true: never prompt (BatchMode=yes), so a missing key fails at once instead of hanging. */
  batchMode?: boolean;
  /** ssh ConnectTimeout, seconds. Default 10. */
  connectTimeoutS?: number;
  /** The ssh program. Default "ssh", found on PATH. */
  sshCommand?: string;
}

const bad = (m: string): never => {
  throw new RuntimeError("misconfigured", `ssh: ${m}`);
};

/** Argument array for ssh, up to and including the destination. Values that could be read as options are rejected. */
export function sshArgs(o: SshOptions): string[] {
  if (!o || typeof o !== "object") bad("options are required: { host, user }");
  if (typeof o.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:%-]*$/.test(o.host))
    bad(`host is required and must be a host name or address, got ${JSON.stringify(o.host)}`);
  if (typeof o.user !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(o.user))
    bad(`user is required, got ${JSON.stringify(o.user)}`);
  const port = o.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) bad(`port must be 1..65535, got ${JSON.stringify(o.port)}`);
  const timeout = o.connectTimeoutS ?? 10;
  if (!Number.isInteger(timeout) || timeout < 1) bad("connectTimeoutS must be a whole number of seconds >= 1");
  const args = [
    "-T",
    "-p",
    String(port),
    "-o",
    `ConnectTimeout=${timeout}`,
    "-o",
    "ServerAliveInterval=2",
    "-o",
    "ServerAliveCountMax=2",
  ];
  if (o.batchMode !== false) args.push("-o", "BatchMode=yes");
  for (const opt of o.options ?? []) {
    if (typeof opt !== "string" || !/^[A-Za-z]+=\S.*$/.test(opt))
      bad(`options entries must look like "Name=value", got ${JSON.stringify(opt)}`);
    args.push("-o", opt);
  }
  if (o.identityFile !== undefined) {
    if (typeof o.identityFile !== "string" || !o.identityFile) bad("identityFile must be a path");
    args.push("-i", o.identityFile);
  }
  args.push(`${o.user}@${o.host}`);
  return args;
}

/** The remote shell parses the path, so only plain path characters (and a leading ~/) are accepted. */
export function checkRemotePath(path: string): string {
  if (typeof path !== "string" || !/^(~\/)?[A-Za-z0-9_./-]+$/.test(path) || path.includes("..") || path.endsWith("/")) {
    bad(
      `remote path must be a plain file path (letters, digits, _ . - /, optional leading ~/), got ${JSON.stringify(path)}`,
    );
  }
  return path;
}

/** Runs the installed bridge on the brick with `python3 -u` over ssh. */
export class SshLineTransport extends ProcessLineTransport {
  constructor(o: SshOptions & { remotePath?: string }) {
    super(
      o.sshCommand ?? "ssh",
      [...sshArgs(o), `python3 -u ${checkRemotePath(o.remotePath ?? DEFAULT_REMOTE_PATH)}`],
      { label: `ssh ${o.user}@${o.host}` },
    );
  }
}

/**
 * Copies the bridge to the brick through ssh's stdin (no scp or sftp needed) and checks the byte
 * count of what landed. Writes to a temporary name first, so a broken copy never replaces a good file.
 */
export async function installBridge(
  o: SshOptions & { remotePath?: string; localFile?: string; timeoutMs?: number },
): Promise<{ remotePath: string; bytes: number }> {
  const remotePath = checkRemotePath(o.remotePath ?? DEFAULT_REMOTE_PATH);
  const dir = posix.dirname(remotePath);
  const data = await readFile(o.localFile ?? BRIDGE_FILE);
  const remote = `mkdir -p ${dir} && cat > ${remotePath}.tmp && mv ${remotePath}.tmp ${remotePath} && wc -c < ${remotePath}`;
  const label = `ssh ${o.user}@${o.host}`;
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(o.sshCommand ?? "ssh", [...sshArgs(o), remote], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 60000);
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr = (stderr + c).slice(-2000);
    });
    child.stdin.on("error", () => {});
    child.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new RuntimeError(
          "robot_offline",
          `${label}: ${e.code === "ENOENT" ? "ssh program not found on PATH" : e.message}`,
          true,
        ),
      );
    });
    child.once("close", (code, sig) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new RuntimeError(
            "robot_offline",
            `${label}: installing the bridge failed (${sig ?? `code ${code}`}): ${stderr.trim() || "no error output"}`,
            true,
          ),
        );
    });
    child.stdin.end(data);
  });
  const landed = Number(out.trim().split(/\s+/).pop());
  if (landed !== data.length)
    throw new RuntimeError(
      "internal",
      `${label}: the bridge on the brick has ${out.trim() || "no"} bytes, expected ${data.length}; the copy is not trustworthy`,
    );
  return { remotePath, bytes: data.length };
}
