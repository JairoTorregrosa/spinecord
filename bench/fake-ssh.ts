#!/usr/bin/env bun
// Stands in for the `ssh` program so installBridge() and SshLineTransport run their real code with no brick
// and no network: it ignores the connection options and runs the remote command (the last argument) with the
// local `sh`, with HOME pointing at a scratch directory (BENCH_FAKE_HOME) that plays the brick's home.
// POSIX only: the remote commands are written for the brick's shell.
const command = process.argv[process.argv.length - 1];
const home = process.env.BENCH_FAKE_HOME;
if (!command || !home) {
  console.error("fake-ssh: needs the remote command as last argument and BENCH_FAKE_HOME");
  process.exit(2);
}
const child = Bun.spawn(["sh", "-c", command], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, HOME: home },
});
process.exit(await child.exited);
export {};
