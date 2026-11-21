// What the page needs to lend a robot: where the relay is, which robot this is, its token and its
// deployment data (profile + EV3 provider config). Pure parsing, no DOM and no I/O: every bad input throws
// a ConfigError that names the field.
import { parseRobotFile, type RobotFile } from "../../../packages/driver-ev3/robot-file";

/** A robot file of a deployment: deployments/<name>/robots/<robot>.json */
export type RobotConfig = RobotFile;
/** One entry of dist/profiles.json, written by build.ts from the deployments folder. */
export interface ProfileEntry {
  id: string; // "<deployment>/<robot file name>"
  config: RobotConfig;
}
export interface PageConfig {
  serverUrl: string; // ws(s)://host/ws/robot
  robotId: string;
  token: string;
  robot: RobotConfig;
}

export type ConfigField = "server" | "robot" | "token" | "profile";
export class ConfigError extends Error {
  constructor(
    public field: ConfigField,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The driver's validator for a robot file, with the page's error type. Accepts the object or its JSON text. */
export function parseRobotConfig(input: unknown): RobotConfig {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      throw new ConfigError("profile", `not valid JSON: ${(e as Error).message}`);
    }
  }
  try {
    return parseRobotFile(raw, "robot file");
  } catch (e) {
    throw new ConfigError("profile", (e as Error).message);
  }
}

/**
 * The relay's robot socket from what a person types: "relay.example.com", "https://relay.example.com" and
 * "wss://relay.example.com/ws/robot" all give wss://relay.example.com/ws/robot. Plain ws:// only for localhost.
 */
export function normalizeServerUrl(input: string): string {
  const text = input.trim();
  if (!text) throw new ConfigError("server", "the server URL is required");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new ConfigError("server", `"${text}" is not a URL`);
  }
  const scheme = { "https:": "wss:", "http:": "ws:", "wss:": "wss:", "ws:": "ws:" }[url.protocol];
  if (!scheme) throw new ConfigError("server", `"${url.protocol}" is not supported: use https:// or wss://`);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (scheme === "ws:" && !local)
    throw new ConfigError("server", "an unencrypted server is only allowed on localhost: use https:// or wss://");
  if (url.username || url.password) throw new ConfigError("server", "credentials do not go in the URL");
  if (url.searchParams.has("token")) throw new ConfigError("server", "the token does not go in the URL");
  const path = url.pathname === "/" || url.pathname === "" ? "/ws/robot" : url.pathname;
  return `${scheme}//${url.host}${path}${url.search}`;
}

export interface HashParams {
  server: string;
  robot: string;
  profile: string;
  /** True when the hash carried a token: it is ignored and must be removed from the address bar. */
  hadToken: boolean;
}
/** Reads #server=…&robot=…&profile=… . A token in the hash is never used. */
export function parseHash(hash: string): HashParams {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    server: q.get("server") ?? "",
    robot: q.get("robot") ?? "",
    profile: q.get("profile") ?? "",
    hadToken: q.has("token"),
  };
}
/** The hash for the current form. It has no token by construction. */
export function formatHash(p: { server: string; robot: string; profile: string }): string {
  const q = new URLSearchParams();
  if (p.server) q.set("server", p.server);
  if (p.robot) q.set("robot", p.robot);
  if (p.profile) q.set("profile", p.profile);
  const text = q.toString();
  return text ? `#${text}` : "";
}

/** Everything the session needs, or the first field that is wrong. */
export function buildPageConfig(form: {
  server: string;
  robot: string;
  token: string;
  robot_json: unknown;
}): PageConfig {
  const serverUrl = normalizeServerUrl(form.server);
  const robot = parseRobotConfig(form.robot_json);
  const robotId = form.robot.trim() || robot.profile.id;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(robotId))
    throw new ConfigError("robot", "the robot id may only have letters, digits, '.', '_' and '-'");
  const token = form.token.trim();
  if (!token) throw new ConfigError("token", "the token is required");
  return { serverUrl, robotId, token, robot };
}
