// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them. Declared here once.
interface Secrets {
  /** JSON: [{principal_id, role: "user"|"admin"|"runtime"|"organ", token_sha256, robot_ids[]}] */
  PRINCIPALS: string;
}
declare namespace Cloudflare {
  interface Env extends Secrets {}
}
interface Env extends Secrets {}
