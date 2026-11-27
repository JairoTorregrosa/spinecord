// The Claude Agent SDK of --chat lives in its own package, apps/chat-sdk: the server's install
// (`bun install --filter @spinecord/local`) leaves out its hundreds of MB of native binaries, and --chat says, before
// it starts, the one command that adds it.
import { join } from "node:path";
import { REPO } from "./config";

/** The folder of @spinecord/chat-sdk, from which the SDK resolves once installed. */
export const CHAT_SDK_DIR = join(import.meta.dir, "..", "..", "chat-sdk");
/** The install of the server with the chat's SDK; keeps what the server's install put. */
export const CHAT_SDK_INSTALL = "bun install --filter @spinecord/local --filter @spinecord/chat-sdk";

/** null when --chat can load the Claude Agent SDK; else what is missing and the command that installs it. */
export function chatSdkMissing(dir = CHAT_SDK_DIR, repo = REPO): string | null {
  try {
    Bun.resolveSync("@anthropic-ai/claude-agent-sdk", dir);
    return null;
  } catch {
    return `--chat needs the Claude Agent SDK, which the server's own install leaves out: in ${repo} run \`${CHAT_SDK_INSTALL}\`, then start again`;
  }
}
