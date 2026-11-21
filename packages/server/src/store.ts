// D1 access (CONTRACT §10). Plain functions; every query is a prepared statement.

import type { CallState, EpisodeSummary, ErrorCode, Program, ProgramState } from "../../protocol/types.ts";
import { PROGRAM_TRANSITIONS } from "../../protocol/types.ts";
import { ToolFail, assertTransition } from "./envelope.ts";

export interface CallRow {
  id: string;
  robot_id: string | null;
  tool: string;
  request_id: string | null;
  state: CallState;
  code: ErrorCode | null;
  ms: number;
  episode_id: string | null;
  created_at: number;
  principal: string | null;
  moving: boolean;
  trace_id: string;
}

export async function insertCall(db: D1Database, c: CallRow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO calls (id, robot_id, tool, request_id, state, code, ms, episode_id, created_at, principal, moving, trace_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
    )
    .bind(
      c.id,
      c.robot_id,
      c.tool,
      c.request_id,
      c.state,
      c.code,
      c.ms,
      c.episode_id,
      c.created_at,
      c.principal,
      c.moving ? 1 : 0,
      c.trace_id,
    )
    .run();
}

export async function listCalls(
  db: D1Database,
  q: { robot_id?: string; since?: number; limit: number },
): Promise<unknown[]> {
  const r = await db
    .prepare(
      "SELECT * FROM calls WHERE (?1 IS NULL OR robot_id = ?1) AND created_at >= ?2 ORDER BY created_at DESC LIMIT ?3",
    )
    .bind(q.robot_id ?? null, q.since ?? 0, q.limit)
    .all();
  return r.results;
}

export async function upsertRobot(
  db: D1Database,
  r: { id: string; owner_principal: string | null; backend: string; profile: unknown; devices: unknown },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO robots (id, owner_principal, backend, profile_json, devices_json, updated_at) VALUES (?1,?2,?3,?4,?5,?6) " +
        "ON CONFLICT(id) DO UPDATE SET owner_principal=?2, backend=?3, profile_json=?4, devices_json=?5, updated_at=?6",
    )
    .bind(r.id, r.owner_principal, r.backend, JSON.stringify(r.profile), JSON.stringify(r.devices), Date.now())
    .run();
}

// ---------- Episodes ----------
const EPISODE_TOOLS = "('start_episode','mark_episode','end_episode')";

export async function insertEpisode(
  db: D1Database,
  e: { id: string; robot_id: string; label: string; tags: string[]; started_at: number },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO episodes (id, robot_id, label, tags_json, state, started_at) VALUES (?1,?2,?3,?4,'running',?5)",
    )
    .bind(e.id, e.robot_id, e.label, JSON.stringify(e.tags), e.started_at)
    .run();
}
export async function insertMark(
  db: D1Database,
  m: { episode_id: string; kind: string; note: string; at: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO episode_marks (id, episode_id, kind, note, at) VALUES (?1,?2,?3,?4,?5)")
    .bind(crypto.randomUUID(), m.episode_id, m.kind, m.note, m.at)
    .run();
}
export async function endEpisode(
  db: D1Database,
  id: string,
  outcome: string,
  metrics: Record<string, number> | undefined,
  ended_at: number,
): Promise<void> {
  await db
    .prepare("UPDATE episodes SET state='ended', ended_at=?2, outcome=?3, metrics_json=?4 WHERE id=?1")
    .bind(id, ended_at, outcome, metrics ? JSON.stringify(metrics) : null)
    .run();
}

interface EpisodeRow {
  id: string;
  robot_id: string;
  label: string;
  tags_json: string;
  state: "running" | "ended";
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  metrics_json: string | null;
}

/** Summary with counters computed from the call log (the episode tools themselves are not counted). */
export async function episodeSummary(db: D1Database, id: string): Promise<EpisodeSummary> {
  const [ep, counts, marks] = await db.batch([
    db.prepare("SELECT * FROM episodes WHERE id=?1").bind(id),
    db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(moving),0) AS moving_calls, COALESCE(SUM(tool IN ('stop','stop_all')),0) AS stops, ` +
          `COALESCE(SUM(state IN ('rejected','failed','timed_out')),0) AS errors FROM calls WHERE episode_id=?1 AND tool NOT IN ${EPISODE_TOOLS}`,
      )
      .bind(id),
    db.prepare("SELECT at, kind, note FROM episode_marks WHERE episode_id=?1 ORDER BY at").bind(id),
  ]);
  const e = ep?.results[0] as EpisodeRow | undefined;
  if (!e) throw new ToolFail("internal", `episode ${id} is not in the database`);
  const c = (counts?.results[0] ?? {}) as { calls: number; moving_calls: number; stops: number; errors: number };
  return {
    id: e.id,
    robot_id: e.robot_id,
    label: e.label,
    tags: JSON.parse(e.tags_json) as string[],
    state: e.state,
    started_at: e.started_at,
    ...(e.ended_at !== null ? { ended_at: e.ended_at } : {}),
    elapsed_ms: (e.ended_at ?? Date.now()) - e.started_at,
    calls: c.calls ?? 0,
    moving_calls: c.moving_calls ?? 0,
    stops: c.stops ?? 0,
    errors: c.errors ?? 0,
    marks: (marks?.results ?? []) as EpisodeSummary["marks"],
    ...(e.outcome !== null ? { outcome: e.outcome } : {}),
    ...(e.metrics_json ? { metrics: JSON.parse(e.metrics_json) as Record<string, number> } : {}),
  };
}
export async function listEpisodes(db: D1Database, robot_id?: string): Promise<EpisodeSummary[]> {
  const r = await db
    .prepare("SELECT id FROM episodes WHERE (?1 IS NULL OR robot_id=?1) ORDER BY started_at DESC LIMIT 100")
    .bind(robot_id ?? null)
    .all<{ id: string }>();
  return Promise.all(r.results.map((x) => episodeSummary(db, x.id)));
}

// ---------- Programs ----------
interface ProgramRow {
  name: string;
  version: number;
  author: string;
  description: string;
  body_json: string;
  success_json: string | null;
  requires_json: string;
  pass_rate: number;
  state: ProgramState;
  success_rate: number | null;
  verified_on_json: string | null;
  created_at: number;
}
export type StoredProgram = Program & { created_at: number };

const toProgram = (r: ProgramRow): StoredProgram => ({
  name: r.name,
  version: r.version,
  description: r.description,
  body: JSON.parse(r.body_json),
  ...(r.success_json ? { success: JSON.parse(r.success_json) } : {}),
  requires: JSON.parse(r.requires_json) as string[],
  pass_rate: r.pass_rate,
  state: r.state,
  ...(r.success_rate !== null ? { success_rate: r.success_rate } : {}),
  ...(r.verified_on_json ? { verified_on: JSON.parse(r.verified_on_json) } : {}),
  author: r.author,
  created_at: r.created_at,
});

export async function saveProgram(
  db: D1Database,
  p: {
    name: string;
    author: string;
    description: string;
    body: unknown;
    success?: unknown;
    requires: string[];
    pass_rate: number;
  },
): Promise<StoredProgram> {
  // version is allocated inside the INSERT, so two concurrent saves cannot take the same number (PK would reject one)
  const row = await db
    .prepare(
      "INSERT INTO programs (name, version, author, description, body_json, success_json, requires_json, pass_rate, state, created_at) " +
        "SELECT ?1, COALESCE(MAX(version),0)+1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8 FROM programs WHERE name=?1 RETURNING *",
    )
    .bind(
      p.name,
      p.author,
      p.description,
      JSON.stringify(p.body),
      p.success === undefined ? null : JSON.stringify(p.success),
      JSON.stringify(p.requires),
      p.pass_rate,
      Date.now(),
    )
    .first<ProgramRow>();
  if (!row) throw new ToolFail("internal", `program ${p.name} was not stored`);
  return toProgram(row);
}

/** Omit version for the latest. Throws invalid_argument when it does not exist. */
export async function getProgram(db: D1Database, name: string, version?: number): Promise<StoredProgram> {
  const row = await db
    .prepare("SELECT * FROM programs WHERE name=?1 AND (?2 IS NULL OR version=?2) ORDER BY version DESC LIMIT 1")
    .bind(name, version ?? null)
    .first<ProgramRow>();
  if (!row)
    throw new ToolFail(
      "invalid_argument",
      `name: no program "${name}"${version !== undefined ? ` version ${version}` : ""} in the library; list_programs shows what exists`,
    );
  return toProgram(row);
}

export async function listPrograms(db: D1Database, q: { query?: string; state?: string } = {}): Promise<unknown[]> {
  const like = q.query ? `%${q.query.replace(/[\\%_]/g, "\\$&")}%` : null;
  const r = await db
    .prepare(
      "SELECT * FROM programs WHERE (?1 IS NULL OR name LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\') AND (?2 IS NULL OR state=?2) ORDER BY name, version DESC LIMIT 200",
    )
    .bind(like, q.state ?? null)
    .all<ProgramRow>();
  return r.results
    .map(toProgram)
    .map(({ name, version, description, state, success_rate, requires, author, verified_on }) => ({
      name,
      version,
      description,
      state,
      success_rate: success_rate ?? null,
      requires,
      author,
      verified_on: verified_on ?? null,
    }));
}

/** Moves a program along PROGRAM_TRANSITIONS. The UPDATE is conditional on the state read, so a race loses loudly. */
export async function transitionProgram(
  db: D1Database,
  p: StoredProgram,
  to: ProgramState,
  success_rate?: number,
  verified_on?: NonNullable<Program["verified_on"]>,
): Promise<StoredProgram> {
  assertTransition(`program ${p.name} v${p.version}`, PROGRAM_TRANSITIONS, p.state, to);
  const r = await db
    .prepare(
      "UPDATE programs SET state=?3, success_rate=COALESCE(?5, success_rate), verified_on_json=COALESCE(?6, verified_on_json) WHERE name=?1 AND version=?2 AND state=?4",
    )
    .bind(p.name, p.version, to, p.state, success_rate ?? null, verified_on ? JSON.stringify(verified_on) : null)
    .run();
  if (r.meta.changes !== 1)
    throw new ToolFail(
      "illegal_state",
      `program ${p.name} v${p.version} changed state while this call ran; get_program shows the current state`,
    );
  return {
    ...p,
    state: to,
    ...(success_rate !== undefined ? { success_rate } : {}),
    ...(verified_on ? { verified_on } : {}),
  };
}
export async function setSuccessRate(db: D1Database, p: StoredProgram, success_rate: number): Promise<void> {
  await db
    .prepare("UPDATE programs SET success_rate=?3 WHERE name=?1 AND version=?2")
    .bind(p.name, p.version, success_rate)
    .run();
}

export async function insertRun(
  db: D1Database,
  r: { name: string; version: number; robot_id: string; backend: string; outcome: string; ms: number },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO program_runs (id, name, version, robot_id, backend, outcome, ms, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
    )
    .bind(crypto.randomUUID(), r.name, r.version, r.robot_id, r.backend, r.outcome, r.ms, Date.now())
    .run();
}
export async function listRuns(db: D1Database, name: string, version: number): Promise<unknown[]> {
  const r = await db
    .prepare(
      "SELECT robot_id, backend, outcome, ms, created_at FROM program_runs WHERE name=?1 AND version=?2 ORDER BY created_at DESC LIMIT 50",
    )
    .bind(name, version)
    .all();
  return r.results;
}
