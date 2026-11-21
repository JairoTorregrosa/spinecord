// Sample statistics, the result file shape and the tables `bun run bench` prints.

export interface Metric {
  /** What one sample measures, in one line. */
  what: string;
  unit: string;
  n: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  /** Why there is no number (a metric is never left out silently). */
  skipped?: string;
  samples?: number[];
}
export interface Results {
  schema: "spinecord/bench@1";
  sha: string;
  /** Tree hash of packages/ at HEAD: two runs with the same value measured the same package code. */
  packages_tree: string;
  /** Uncommitted changes under packages/ when the run started. */
  packages_dirty: boolean;
  at: string;
  seed: number;
  wall_s: number;
  machine: Record<string, string | number>;
  /** Fixed parameters of the run (speeds, thresholds, link profiles), so a comparison is like for like. */
  params: Record<string, unknown>;
  metrics: Record<string, Metric>;
  /** Evidence for hotspot hunting: per-layer splits and op counts. Not compared. */
  breakdown: Record<string, unknown>;
}

export const round = (x: number) => Math.round(x * 1000) / 1000;

/** Nearest-rank percentile on a sorted copy. */
export function percentile(samples: number[], p: number): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export function metric(what: string, samples: number[], unit = "ms"): Metric {
  if (samples.length === 0) return skipped(what, "no samples", unit);
  return {
    what,
    unit,
    n: samples.length,
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    mean: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    samples: samples.map(round),
  };
}
export function skipped(what: string, why: string, unit = "ms"): Metric {
  return { what, unit, n: 0, p50: null, p95: null, min: null, max: null, mean: null, skipped: why };
}
/** A metric derived from two others (a difference of percentiles), not sampled itself. */
export function derived(what: string, p50: number | null, p95: number | null, n: number, unit = "ms"): Metric {
  return {
    what,
    unit,
    n,
    p50: p50 === null ? null : round(p50),
    p95: p95 === null ? null : round(p95),
    min: null,
    max: null,
    mean: null,
  };
}

/** Deterministic PRNG (mulberry32): the same seed gives the same jitter on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const num = (x: number | null) =>
  x === null ? "-" : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);

function table(head: string[], right: number[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map((_, i) => (right.includes(i) ? "---:" : "---"))), ...rows.map(line)].join("\n");
}

export function resultsTable(r: Results): string {
  return table(
    ["metric", "p50", "p95", "n", "unit", "what"],
    [1, 2, 3],
    Object.entries(r.metrics).map(([name, m]) => [
      name,
      num(m.p50),
      num(m.p95),
      String(m.n),
      m.unit,
      m.skipped ? `SKIPPED: ${m.skipped}` : m.what,
    ]),
  );
}

/** Before/after. speedup = before / after (above 1 is better); for counts and bytes it reads as "times fewer". */
export function compareTable(a: Results, b: Results): string {
  const names = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])];
  const ratio = (x: number | null | undefined, y: number | null | undefined) =>
    x === null || x === undefined || y === null || y === undefined || y <= 0 || x <= 0 ? "-" : `${(x / y).toFixed(2)}x`;
  return table(
    ["metric", "p50 before", "p50 after", "speedup p50", "p95 before", "p95 after", "speedup p95", "unit"],
    [1, 2, 3, 4, 5, 6],
    names.map((name) => {
      const x = a.metrics[name],
        y = b.metrics[name];
      return [
        name,
        num(x?.p50 ?? null),
        num(y?.p50 ?? null),
        ratio(x?.p50, y?.p50),
        num(x?.p95 ?? null),
        num(y?.p95 ?? null),
        ratio(x?.p95, y?.p95),
        (x ?? y)!.unit,
      ];
    }),
  );
}
