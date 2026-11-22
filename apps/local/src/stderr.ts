// stdout belongs to JSON-RPC (MCP over stdio): one stray line there and the client drops the connection.
// Imported first by main.ts, before any module that could print: every console method writes to stderr.
const toStderr = (...args: unknown[]): void => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

/** One JSON line per event on stderr: {"ev": ..., ...fields}. */
export function log(ev: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ev, ...fields })}\n`);
}
