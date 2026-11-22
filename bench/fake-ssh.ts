#!/usr/bin/env bun
// Stands in for the `ssh` program so installBridge() and SshLineTransport run their real code with no brick
// and no network: it ignores the connection options and runs the remote command (the last argument) with the
// local `sh`, with HOME pointing at a scratch directory (BENCH_FAKE_HOME) that plays the brick's home.
// BENCH_FAKE_DOWN names a file: while it exists the host is unreachable (a connection in progress is cut, a new
// one is refused), as when the brick is turned off.
// POSIX only: the remote commands are written for the brick's shell.
import { existsSync } from "node:fs";

const command = process.argv[process.argv.length - 1];
const home = process.env.BENCH_FAKE_HOME;
if (!command || !home) {
  console.error("fake-ssh: needs the remote command as last argument and BENCH_FAKE_HOME");
  process.exit(2);
}
const down = process.env.BENCH_FAKE_DOWN;
if (down && existsSync(down)) {
  console.error("fake-ssh: connect to host: Connection refused");
  process.exit(255);
}
const child = Bun.spawn(["sh", "-c", command], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, HOME: home },
});
if (down)
  setInterval(() => {
    if (existsSync(down)) child.kill("SIGKILL");
  }, 20).unref();
const code = await child.exited;
process.exit(existsSync(down ?? "") ? 255 : code);
