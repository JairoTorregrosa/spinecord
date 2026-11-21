// One JSON line per event, so an agent can filter remotely (`wrangler tail --format json`, Workers Logs).
// Never pass a token here: callers are identified by principal_id only.

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(ev: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ev, ts: new Date().toISOString(), ...fields });
  if (fields.ok === false || ev.endsWith("_error")) console.warn(line);
  else console.log(line);
}
