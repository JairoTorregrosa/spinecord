// --chat's Claude Agent SDK is a package of its own (apps/chat-sdk): the server's install leaves it out, and --chat
// without it says, before it starts, the one command that adds it.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_SDK_INSTALL, chatSdkMissing } from "../src/chat-sdk";
import { REPO } from "../src/config";
import { doctor, type Probes } from "../src/doctor";

const pkg = (p: string) => JSON.parse(readFileSync(join(REPO, p, "package.json"), "utf8"));

test("the server's own package does not pull the SDK; apps/chat-sdk does, at the version the example uses", () => {
  expect(Object.keys(pkg("apps/local").dependencies ?? {})).not.toContain("@anthropic-ai/claude-agent-sdk");
  expect(pkg("apps/chat-sdk").dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(
    pkg("examples/assistant").dependencies["@anthropic-ai/claude-agent-sdk"],
  );
  expect(pkg(".").workspaces).toContain("apps/chat-sdk");
});

test("without the SDK: what is missing, where, and the one command that installs it", () => {
  const empty = mkdtempSync(join(tmpdir(), "spinecord-no-sdk-"));
  try {
    const m = chatSdkMissing(empty, "/home/ana/spinecord");
    expect(m).toBe(
      "--chat needs the Claude Agent SDK, which the server's own install leaves out: in /home/ana/spinecord run " +
        "`bun install --filter @spinecord/local --filter @spinecord/chat-sdk`, then start again",
    );
    expect(m).toContain(CHAT_SDK_INSTALL);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  // this checkout's development install (`bun install`) has it
  expect(chatSdkMissing()).toBeNull();
});

test("the doctor fails --chat without the SDK, with the command; says ok with it; says nothing without --chat", async () => {
  const filesOnly = { assistant: false, filesOnly: true } as const;
  const p = {} as Probes; // files only: no probe of this computer runs
  const args = ["--twin", "--view", "--chat"];
  const without = await doctor({ ...filesOnly, robotArgs: args, chatSdkMissing: () => "--chat needs the SDK" }, p);
  expect(without.code).toBe(1);
  expect(without.lines.find((l) => l.check === "chat")).toEqual({
    status: "fail",
    check: "chat",
    reason: "--chat needs the SDK",
    next: `in ${REPO} run ${CHAT_SDK_INSTALL}`,
  });
  const withIt = await doctor({ ...filesOnly, robotArgs: args, chatSdkMissing: () => null }, p);
  expect(withIt.code).toBe(0);
  expect(withIt.lines.find((l) => l.check === "chat")?.status).toBe("ok");
  const none = await doctor({ ...filesOnly, robotArgs: ["--twin", "--view"], chatSdkMissing: () => "x" }, p);
  expect(none.lines.some((l) => l.check === "chat")).toBe(false);
});
