// What to do when a twin's socket closes: give up (the relay will never accept this twin as it is) or try again.
// The runtime client only reports "closed" with the close code; a refusal during the WebSocket handshake
// (HTTP 401, 403, 404: unknown robot id, bad route) has no close code at all, so the upgrade is asked again
// over plain HTTP to read the status the relay answers with.

export type CloseVerdict = { retry: false; why: string } | { retry: true; why: string };

/** The relay's close codes for a socket it will never accept as it is (packages/server: REFUSED, REPLACED). */
const FATAL_CLOSE = /^code (4001|4002)\b/;
const PROBE_TIMEOUT_MS = 3000;
/** 4xx answers that are about this moment, not about the request. */
const TRANSIENT_4XX = new Set([408, 425, 429]);

/** The URL the runtime client opens: the robot id is appended when the URL has none (packages/runtime/client.ts). */
export function upgradeUrl(server: string, robot_id: string): string {
  return /[?&]robot_id=/.test(server)
    ? server
    : `${server}${server.includes("?") ? "&" : "?"}robot_id=${encodeURIComponent(robot_id)}`;
}

/** Wait before reconnect number `attempt` (0 = the first one after a close): 1 s, doubling, at most 15 s. */
export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** Math.min(attempt, 10), 15_000);

/**
 * Judges one close. `detail` is the client's ("code <n> <reason>"). Permanent: the relay's refusal codes, and a
 * 4xx answer to the upgrade. Everything else (relay unreachable, 5xx, heartbeat lost, upgrade accepted) is retried.
 */
export async function judgeClose(
  detail: string,
  server: string,
  robot_id: string,
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<CloseVerdict> {
  if (FATAL_CLOSE.test(detail)) return { retry: false, why: `the relay closed the socket (${detail})` };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(upgradeUrl(server, robot_id).replace(/^ws/, "http"), {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
      },
      signal: abort.signal,
    });
    if (res.status >= 400 && res.status < 500 && !TRANSIENT_4XX.has(res.status)) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      return {
        retry: false,
        why: `the relay refuses the WebSocket upgrade with HTTP ${res.status}${body ? `: ${body}` : ""} (check --server, --robot-id and the token's principal)`,
      };
    }
    return { retry: true, why: `${detail}; the upgrade now answers HTTP ${res.status}` };
  } catch (e) {
    return { retry: true, why: `${detail}; relay not reachable (${(e as Error).message})` };
  } finally {
    clearTimeout(timer);
    abort.abort(); // drop the probe's connection, also when the relay accepted the upgrade
  }
}
