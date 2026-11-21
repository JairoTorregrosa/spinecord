// Read-only smoke check of a real ev3dev brick over ssh.
//   bun scripts/smoke-ssh.ts --host 192.168.0.50 --user robot [--port 22] [--identity <key file>] [--remote-path ~/spinecord/ev3dev_bridge.py] [--ssh-option ControlPath=~/.ssh/cm/x]
// It installs the bridge on the brick, then asks for the inventory and reads every device.
// It cannot move the robot: the transport is wrapped so that only hello, read and hb are ever sent,
// and reads never switch a sensor mode. The limits below are required by the provider and unused.
// Prints one JSON document; exit code 0 = every step answered, 1 = something failed.
import { Ev3devProvider, readOnlyTransport, type LineTransport } from "../src/provider";
import { DEFAULT_REMOTE_PATH, SshLineTransport, installBridge, type SshOptions } from "../src/ssh";

function parse(argv: string[]): SshOptions & { remotePath: string } {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const host = get("host"),
    user = get("user");
  if (!host || !user) {
    console.error(
      "usage: bun scripts/smoke-ssh.ts --host <host> --user <user> [--port 22] [--identity <key file>] [--remote-path <path>] [--ssh-option Name=value]...",
    );
    process.exit(2);
  }
  const port = get("port");
  const options = argv.flatMap((a, i) => (a === "--ssh-option" && argv[i + 1] ? [argv[i + 1]!] : []));
  return {
    host,
    user,
    port: port === undefined ? 22 : Number(port),
    identityFile: get("identity"),
    options,
    remotePath: get("remote-path") ?? DEFAULT_REMOTE_PATH,
  };
}

const ssh = parse(process.argv.slice(2));
const report: Record<string, unknown> = { host: ssh.host, port: ssh.port, user: ssh.user };
const sent: string[] = [];
let provider: Ev3devProvider | null = null;
let failed = false;
try {
  report.install = await installBridge(ssh);
  const guarded = readOnlyTransport(new SshLineTransport(ssh));
  const logged: LineTransport = {
    ...guarded,
    send(line) {
      const op = String((JSON.parse(line) as { op?: string }).op);
      if (op !== "hb") sent.push(op);
      guarded.send(line);
    },
  };
  provider = new Ev3devProvider(logged, {
    limits: { max_speed_pct: 1, max_command_ms: 1 },
    hardware: { low_battery_v: 6.5, max_tone_ms: 1 },
  });
  const t0 = Date.now();
  const devices = await provider.devices();
  report.hello_ms = Date.now() - t0;
  report.inventory = provider.inventory();
  report.devices = devices.map((d) => ({
    id: d.id,
    kind: d.kind,
    channels: d.channels.map((c) => `${c.name}${c.active === false ? " (inactive)" : ""}`),
    commands: d.commands.map((c) => c.name),
    description: d.description,
  }));
  const readings = [];
  for (const d of devices) {
    if (!d.channels.length) continue;
    const t = Date.now();
    try {
      readings.push(...(await provider.read(d.id)).map((r) => ({ ...r, ms: Date.now() - t })));
    } catch (e) {
      failed = true;
      readings.push({ device: d.id, error: `${(e as { code?: string }).code ?? "error"}: ${(e as Error).message}` });
    }
  }
  report.readings = readings;
  report.battery = readings.filter((r) => r.device === `${provider!.id}.battery`);
} catch (e) {
  failed = true;
  report.error = `${(e as { code?: string }).code ?? "error"}: ${(e as Error).message}`;
} finally {
  await provider?.close().catch(() => {});
}
report.ops_sent = sent;
report.ok = !failed;
console.log(JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
