// stdout belongs to JSON-RPC (MCP over stdio): one stray line there and the client drops the connection.
// Imported first by main.ts, ahead of any module that could print: every console method writes to stderr.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const toStderr = (...args: unknown[]): void => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

/**
 * The file of `--log-file`, open for appending. undefined when the flag was not given, and after a write to
 * the file failed: the file is then given up for the rest of the process.
 */
let file: { path: string; fd: number } | undefined;

/**
 * `--log-file`: every line of `log` also goes to the end of this file, written synchronously, so the last
 * lines of a process that exits are in it. Creates the file's folder. Throws when the file cannot be opened.
 * A write that fails later (a full disk) never reaches the caller of `log`, which may be the code that stops
 * the robots: the file is given up, one `log_file_failed` line says so on stderr, and stderr goes on alone.
 */
export function logTo(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    file = { path, fd: openSync(path, "a") };
  } catch (e) {
    throw new Error(`--log-file: cannot open ${path} for appending: ${(e as Error).message}`, { cause: e });
  }
}

/** One JSON line per event on stderr, and in the file of `--log-file`: {"ev": ..., ...fields}. */
export function log(ev: string, fields: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ ev, ...fields })}\n`;
  process.stderr.write(line);
  if (file === undefined) return;
  try {
    writeSync(file.fd, line);
  } catch (e) {
    const { path, fd } = file;
    file = undefined;
    try {
      closeSync(fd);
    } catch {
      // the write error is the one reported
    }
    process.stderr.write(`${JSON.stringify({ ev: "log_file_failed", path, error: (e as Error).message })}\n`);
  }
}
