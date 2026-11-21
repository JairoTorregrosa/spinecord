// pre-commit: scan the staged changes for secrets. Cross-platform: `bun scripts/gitleaks-staged.ts`.
// CI runs gitleaks on every push, so a machine without it is told and not blocked.
const bin = Bun.which("gitleaks");
if (!bin) {
  console.warn(
    "gitleaks: SKIPPED, not installed on this machine (https://github.com/gitleaks/gitleaks#installing). CI still scans every push.",
  );
  process.exit(0);
}
const r = Bun.spawnSync([bin, "git", "--staged", "--no-banner", "--redact"], { stdout: "inherit", stderr: "inherit" });
process.exit(r.exitCode ?? 1);
