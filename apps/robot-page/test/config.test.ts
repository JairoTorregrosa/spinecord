import { describe, expect, test } from "bun:test";
import {
  buildPageConfig,
  ConfigError,
  formatHash,
  normalizeServerUrl,
  parseHash,
  parseRobotConfig,
  type ConfigField,
} from "../src/config";
import { COPY, pickCopy } from "../src/copy";
import { ROBOT } from "./fakes";

const field = (fn: () => unknown): ConfigField | "no error" => {
  try {
    fn();
    return "no error";
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.field;
  }
};

describe("server URL", () => {
  test("what a person types becomes the relay's robot socket", () => {
    expect(normalizeServerUrl("relay.example.com")).toBe("wss://relay.example.com/ws/robot");
    expect(normalizeServerUrl(" https://relay.example.com/ ")).toBe("wss://relay.example.com/ws/robot");
    expect(normalizeServerUrl("wss://relay.example.com/ws/robot")).toBe("wss://relay.example.com/ws/robot");
    expect(normalizeServerUrl("http://localhost:8787")).toBe("ws://localhost:8787/ws/robot");
    expect(normalizeServerUrl("ws://127.0.0.1:8787/custom")).toBe("ws://127.0.0.1:8787/custom");
  });
  test("empty, unencrypted remote, other schemes and secrets in the URL are refused", () => {
    for (const bad of [
      "",
      "http://relay.example.com",
      "ws://relay.example.com/ws/robot",
      "ftp://relay.example.com",
      "https://user:pass@relay.example.com",
      "https://relay.example.com/ws/robot?token=abc",
      "https://",
    ])
      expect(field(() => normalizeServerUrl(bad))).toBe("server");
  });
});

describe("hash", () => {
  test("reads server, robot and profile; a token is flagged and never returned", () => {
    const h = parseHash("#server=https%3A%2F%2Frelay.example.com&robot=r1&profile=example%2Fr1&token=abc");
    expect(h).toEqual({
      server: "https://relay.example.com",
      robot: "r1",
      profile: "example/r1",
      hadToken: true,
    });
    expect(JSON.stringify(h)).not.toContain("abc");
    expect(parseHash("")).toEqual({ server: "", robot: "", profile: "", hadToken: false });
  });
  test("the written hash round-trips and cannot carry a token", () => {
    const text = formatHash({ server: "https://relay.example.com", robot: "r1", profile: "example/r1" });
    expect(parseHash(text)).toMatchObject({ server: "https://relay.example.com", robot: "r1", hadToken: false });
    expect(formatHash({ ...parseHash("#robot=r1&token=abc") })).toBe("#robot=r1");
    expect(formatHash({ server: "", robot: "", profile: "" })).toBe("");
  });
});

describe("robot config", () => {
  test("accepts an object or its JSON text", () => {
    expect(parseRobotConfig(ROBOT).profile.id).toBe("test-ev3");
    expect(parseRobotConfig(JSON.stringify({ ...ROBOT, pair: { left: "A", right: "D" } })).pair).toEqual({
      left: "A",
      right: "D",
    });
  });
  test("every missing piece is named, as a profile field error", () => {
    const without = (path: string[]) => {
      const copy = JSON.parse(JSON.stringify(ROBOT)) as Record<string, unknown>;
      let at = copy;
      for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
      delete at[path.at(-1)!];
      return copy;
    };
    const message = (input: unknown) => {
      try {
        parseRobotConfig(input);
        return "no error";
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).field).toBe("profile");
        return (e as Error).message;
      }
    };
    expect(message("{not json")).toContain("not valid JSON");
    expect(message("[]")).toContain("must be an object");
    expect(message(without(["profile"]))).toContain("profile must be an object");
    expect(message(without(["profile", "id"]))).toContain("profile.id");
    expect(message(without(["profile", "roles"]))).toContain("profile.roles");
    expect(message(without(["profile", "limits", "max_turn_deg"]))).toContain("profile.limits.max_turn_deg");
    expect(message(without(["profile", "notes"]))).toContain("profile.notes");
    expect(message(without(["hardware"]))).toContain("hardware must be an object");
    expect(message(without(["hardware", "low_battery_v"]))).toContain("hardware.low_battery_v");
    expect(message(without(["pair"]))).toContain("pair must be an object");
    expect(message({ ...ROBOT, pair: { left: "B", right: "B" } })).toContain("two different ports");
    expect(message({ ...ROBOT, pair: { left: "B", right: "E" } })).toContain("pair.right");
    // the old page-only shape is not accepted
    expect(message({ profile: ROBOT.profile, ev3: { hardware: ROBOT.hardware } })).toContain("pair must be an object");
  });
});

describe("page config", () => {
  const form = { server: "relay.example.com", robot: "", token: " tok ", robot_json: ROBOT };
  test("robot id defaults to the profile's; the token is trimmed", () => {
    expect(buildPageConfig(form)).toMatchObject({
      serverUrl: "wss://relay.example.com/ws/robot",
      robotId: "test-ev3",
      token: "tok",
    });
    expect(buildPageConfig({ ...form, robot: "other-1" }).robotId).toBe("other-1");
  });
  test("each wrong field is named", () => {
    expect(field(() => buildPageConfig({ ...form, server: "" }))).toBe("server");
    expect(field(() => buildPageConfig({ ...form, robot: "has space" }))).toBe("robot");
    expect(field(() => buildPageConfig({ ...form, token: "  " }))).toBe("token");
    expect(field(() => buildPageConfig({ ...form, robot_json: "" }))).toBe("profile");
  });
});

describe("copy", () => {
  const shape = (x: unknown): unknown =>
    typeof x === "object" && x !== null
      ? Object.fromEntries(
          Object.entries(x)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => [k, shape(v)]),
        )
      : typeof x;
  test("English and Spanish have the same keys and no empty string", () => {
    expect(shape(COPY.es)).toEqual(shape(COPY.en));
    const empty = (x: unknown): boolean =>
      typeof x === "string" ? x.trim() === "" : Object.values(x as object).some(empty);
    expect(empty(COPY.en) || empty(COPY.es)).toBe(false);
  });
  test("Spanish locales get Spanish, everything else English", () => {
    expect(pickCopy("es-CO").connect).toBe("Conectar EV3");
    expect(pickCopy("es").lang).toBe("es");
    expect(pickCopy("en-US").connect).toBe("Connect EV3");
    expect(pickCopy("pt-BR").lang).toBe("en");
    expect(pickCopy(undefined).lang).toBe("en");
  });
  test("the unsupported-browser message names the browsers that work", () => {
    for (const c of [COPY.en, COPY.es]) expect(c.problem.webhid_unsupported).toMatch(/Chrome.*Edge/);
  });
});
