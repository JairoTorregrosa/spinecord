// main.ts with the network of --lan replaced: the interface is 10.0.0.5 (bound as 127.0.0.1), the name resolves,
// and the LAN-name service either answers with a test certificate (LAN_TEST=ok) or cannot be reached
// (LAN_TEST=unreachable). LAN_TEST_CACHE is the certificate cache folder. Same arguments and stdio as main.ts.
import "../src/stderr"; // first: it moves console output off stdout
import { loadConfig } from "../src/config";
import { serve } from "../src/serve";
import { testCert } from "./tls";

const mode = process.env.LAN_TEST;
const cacheDir = process.env.LAN_TEST_CACHE;
if ((mode !== "ok" && mode !== "unreachable") || !cacheDir)
  throw new Error("lan-main.ts needs LAN_TEST=ok|unreachable and LAN_TEST_CACHE=<folder>");
const service = testCert({ dns: ["*.local-ip.sh"], ips: ["127.0.0.1"] });

await serve(loadConfig(process.argv.slice(2)), {
  lan: {
    interfaces: () => ({ wlan0: [{ address: "10.0.0.5", family: "IPv4", internal: false } as never] }),
    defaultRoute: async () => null,
    bindAddress: "127.0.0.1",
    resolve: async () => "10.0.0.5",
    cacheDir,
    fetchText: async (url) => {
      if (mode === "unreachable") throw new Error("getaddrinfo ENOTFOUND local-ip.sh");
      return url.endsWith(".key") ? service.key : service.cert;
    },
  },
});
