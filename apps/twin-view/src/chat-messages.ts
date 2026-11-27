// The chat of the 3D view (`--chat`, CONTRACT §6, experimental): the messages between apps/local's chat
// (src/chat.ts) and the page's panel (src/chat.ts here), over the view's socket, and the one rule both sides
// apply to a stop word. Pure: no DOM, no I/O.

/**
 * The chat's states. `off` is final: its `why` says what happened and what to do. Turns: `idle → thinking`,
 * `thinking ⇄ acting` while tools run, back to `idle` at the end; `stopping` while a stop interrupts a turn.
 */
export type ChatState = "starting" | "idle" | "thinking" | "acting" | "stopping" | "off";

/** The legal transitions; the process asserts every one (`off` has none). */
export const CHAT_TRANSITIONS: Record<ChatState, readonly ChatState[]> = {
  starting: ["idle", "off"],
  idle: ["thinking", "stopping", "off"],
  thinking: ["acting", "idle", "stopping", "off"],
  acting: ["thinking", "idle", "stopping", "off"],
  stopping: ["idle", "off"],
  off: [],
};

/** Why the chat is `off`, for the page's own words; `why` carries the detail in English. */
export type ChatOffCode = "no_login" | "start_failed" | "budget" | "session_ended" | "ending";

export interface ChatStatus {
  t: "chat";
  state: ChatState;
  /** The robot the chat speaks as: its id and its name (the id when it has none). */
  robot: { id: string; name: string };
  model: string;
  /** Who pays, as Claude Code said at start ("paid by: Console login, ant profile credits"); null before. */
  paid_by: string | null;
  spent_usd: number;
  budget_usd: number;
  /** Only when `off`. */
  off?: { code: ChatOffCode; why: string };
}

export type ChatServerMessage =
  | ChatStatus
  /** A message of the person, as accepted: every page shows it. */
  | { t: "chat_user"; turn: number; text: string; via: ChatVia; at: number }
  /** More of Claude's text in this turn, as it streams. */
  | { t: "chat_delta"; turn: number; text: string }
  /** The turn ended. `error` when it failed (the chat is `idle` again unless it went `off`). */
  | {
      t: "chat_end";
      turn: number;
      ok: boolean;
      cost_usd: number;
      ms: number;
      error?: string;
      /** The turn was cut by a stop. */
      stopped?: boolean;
    }
  /** A stop ran: the process stopped these robots, `ms` after it was asked. */
  | { t: "chat_stopped"; ms: number; robots: { id: string; ok: boolean; motors_stopped: boolean | null }[] }
  /** A message of this page was not taken: `code` for the page's words, `error` in English. */
  | { t: "chat_refused"; code: "busy" | "off" | "invalid"; error: string };

export type ChatVia = "typed" | "voice";

export type ChatPageMessage = { t: "chat_send"; text: string; via: ChatVia } | { t: "chat_stop" };

/** Longest text the page may send: a spoken command is a sentence, and the view's messages are at most 2 KB. */
export const CHAT_TEXT_MAX = 400;

const STOP_WORDS = new Set(["para", "parate", "páralo", "paralo", "alto", "stop", "detente", "quieto", "quieta", "ya"]);
/** Words that may stand beside a stop word without making it a command for Claude ("¡para ya!", "stop now"). */
const STOP_COMPANIONS = new Set([
  "ya",
  "robot",
  "ahora",
  "now",
  "please",
  "porfa",
  "todo",
  "eso",
  "para",
  "alto",
  "stop",
  "ahí",
  "ahi",
]);

/**
 * Whether `text` is only a stop: a stop word, alone or with at most one more word, in any case and punctuation.
 * "para", "¡Para ya!", "alto robot", "Stop." are; "avanza para adelante" and "para qué sirve" are not: "para" is
 * also "for" in Spanish, so a sentence that merely holds it is a message for Claude.
 */
export function isStopUtterance(text: string): boolean {
  const words = text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 2) return false;
  if (!words.some((w) => STOP_WORDS.has(w))) return false;
  return words.every((w) => STOP_WORDS.has(w) || STOP_COMPANIONS.has(w));
}
