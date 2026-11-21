// Generic world viewer for a page: draws live whatever the host (a WorldHost) has, lets the person load a world
// file, and trains a policy from a training spec (data, no code). It does not know what robot sits on top.
// Element ids it expects: arena, camera, world, worldFile, spec, specFile, specText, episodes, train, play, status, curve.
import { World, parseWorld, Rng, type Vec, type DriveGeometry } from "./world";
import type { WorldHost } from "./world-provider";
import { drawWorld, renderFirstPerson } from "./render";
import { Episode, greedyAction, parseTrainingSpec, type DeviceBindings, type Policy } from "./learn";
import type { TrainRequest } from "./train-job";
import { trainInWorker, type TrainWorker } from "./train-supervisor";

export interface ViewerOptions {
  host: WorldHost;
  /** Worlds offered at start (name -> world file JSON). More can be added from the page. */
  worlds: Record<string, unknown>;
  /** Training specs offered at start (name -> spec JSON). The page edits them as text or loads another file. */
  specs: Record<string, unknown>;
  /** Device id or role -> what it is in the twin, for the world currently loaded (see DeviceBindings). */
  bindings: () => DeviceBindings;
  /** Drivetrain geometry from the robot profile, or null if the robot has none (then training is refused). */
  drive: () => DriveGeometry | null;
  /** Creates the Worker that trains (the train-worker.ts bundle). Training never runs on the page thread. */
  createTrainWorker: () => TrainWorker;
  /** Hard time budget per training episode, ms (default 2000). */
  episodeBudgetMs?: number;
  scale?: number;
  seed?: number;
  /** Called every frame while no policy is being played back. */
  onFrame?: (t_ms: number) => void;
}
export interface Viewer {
  readonly playing: boolean;
  stopPlaying(): void;
  el<T extends HTMLElement>(id: string): T;
}

export function mountViewer(opts: ViewerOptions): Viewer {
  const { host } = opts,
    scale = opts.scale ?? 5,
    seed = opts.seed ?? 1;
  const worlds = { ...opts.worlds };
  const el = <T extends HTMLElement>(id: string): T => {
    const e = document.getElementById(id);
    if (!e) throw new Error(`the page has no #${id} element`);
    return e as T;
  };
  const canvas = el<HTMLCanvasElement>("arena"),
    ctx = canvas.getContext("2d")!;
  const cam = el<HTMLCanvasElement>("camera"),
    camCtx = cam.getContext("2d")!;
  const curve = el<HTMLCanvasElement>("curve"),
    cctx = curve.getContext("2d")!;
  const worldSel = el<HTMLSelectElement>("world"),
    specSel = el<HTMLSelectElement>("spec");
  const specBox = el<HTMLTextAreaElement>("specText"),
    status = el("status"),
    playBtn = el<HTMLButtonElement>("play");
  let policy: Policy | null = null,
    trail: Vec[] = [],
    playing = false,
    training = false;
  const say = (text: string, error = false): void => {
    status.textContent = text;
    status.className = error ? "err" : "";
  };

  function draw(): void {
    const world = host.world,
      last = trail[trail.length - 1];
    if (!last || Math.hypot(last[0] - world.pose.x, last[1] - world.pose.y) > 0.3)
      trail.push([world.pose.x, world.pose.y]);
    if (trail.length > 4000) trail.shift();
    drawWorld(ctx, world, { scale, trail });
    const img = renderFirstPerson(world);
    const id = camCtx.createImageData(img.width, img.height);
    id.data.set(img.data);
    camCtx.putImageData(id, 0, 0);
  }
  function loadWorld(name: string): void {
    playing = false;
    try {
      host.setWorld(new World(parseWorld(worlds[name]), seed));
    } catch (e) {
      say(`${name}: ${(e as Error).message}`, true);
      return;
    }
    const world = host.world;
    canvas.width = world.cfg.width * scale;
    canvas.height = world.cfg.height * scale;
    trail = [];
    policy = null;
    playBtn.disabled = true;
    draw();
  }
  function drawCurve(values: number[]): void {
    const W = curve.width,
      H = curve.height;
    cctx.fillStyle = "#fff";
    cctx.fillRect(0, 0, W, H);
    if (values.length === 0) return;
    const win = Math.max(1, Math.floor(values.length / 60));
    const smooth = values.map((_, i) => {
      const a = values.slice(Math.max(0, i - win + 1), i + 1);
      return a.reduce((x, y) => x + y, 0) / a.length;
    });
    const lo = Math.min(...smooth),
      hi = Math.max(...smooth),
      span = hi - lo || 1;
    cctx.strokeStyle = "#2a6fdb";
    cctx.lineWidth = 2;
    cctx.beginPath();
    smooth.forEach((v, i) => {
      const x = 30 + (i / Math.max(1, smooth.length - 1)) * (W - 40),
        y = H - 20 - ((v - lo) / span) * (H - 35);
      if (i) cctx.lineTo(x, y);
      else cctx.moveTo(x, y);
    });
    cctx.stroke();
    cctx.fillStyle = "#444";
    cctx.font = "11px sans-serif";
    cctx.fillText(hi.toFixed(0), 2, 16);
    cctx.fillText(lo.toFixed(0), 2, H - 20);
    cctx.fillText("reward per episode \u2192", 30, H - 5);
  }
  const showSpec = (name: string): void => {
    specBox.value = JSON.stringify(opts.specs[name], null, 2);
  };

  for (const name of Object.keys(worlds)) worldSel.add(new Option(name, name));
  worldSel.onchange = () => loadWorld(worldSel.value);
  for (const name of Object.keys(opts.specs)) specSel.add(new Option(name, name));
  specSel.onchange = () => showSpec(specSel.value);
  el<HTMLInputElement>("worldFile").onchange = async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text()) as unknown;
      const name = parseWorld(json).name;
      if (!(name in worlds)) worldSel.add(new Option(name, name));
      worlds[name] = json;
      worldSel.value = name;
      say(`World "${name}" loaded`);
      loadWorld(name);
    } catch (e) {
      say(`${file.name}: ${(e as Error).message}`, true);
    }
  };
  el<HTMLInputElement>("specFile").onchange = async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (file) specBox.value = await file.text();
  };
  el("train").onclick = () => {
    if (training) return;
    let spec: unknown;
    try {
      spec = JSON.parse(specBox.value);
      parseTrainingSpec(spec);
    } catch (e) {
      say((e as Error).message, true);
      return;
    }
    const drive = opts.drive();
    if (!drive) {
      say("This robot's profile has no drivetrain: its wheels cannot move it, so there is nothing to train", true);
      return;
    }
    host.tick();
    const world = host.world;
    const req: TrainRequest = {
      cfg: world.cfg,
      pose: { ...world.pose },
      drive,
      spec,
      bindings: opts.bindings(),
      episodes: +el<HTMLSelectElement>("episodes").value,
      seed,
    };
    training = true;
    say("Training\u2026");
    let shown = 0;
    trainInWorker(req, {
      createWorker: opts.createTrainWorker,
      episode_budget_ms: opts.episodeBudgetMs,
      onProgress: (n, total) => {
        if (n - shown >= total / 20) {
          shown = n;
          say(`Training\u2026 episode ${n} of ${total}`);
        }
      },
    })
      .then(
        (r) => {
          if (host.world !== world) {
            say("The world changed while training: train again in this one", true);
            return;
          }
          policy = r.result.policy;
          playBtn.disabled = false;
          drawCurve(r.result.curve);
          say(
            `Success ${(r.result.success_rate * 100).toFixed(0)} % (random ${(r.random_success_rate * 100).toFixed(0)} %) \u00b7 ${r.result.curve.length} episodes \u00b7 ${r.ms.toFixed(0)} ms`,
          );
        },
        (e: Error) => say(e.message, true),
      )
      .finally(() => {
        training = false;
      });
  };
  playBtn.onclick = () => {
    if (!policy || playing) return;
    playing = true;
    trail = [];
    const rng = new Rng(Math.floor(performance.now()));
    const p = policy;
    let ep: Episode;
    try {
      host.tick();
      ep = new Episode(host.world, p.spec, opts.bindings(), rng);
    } catch (e) {
      playing = false;
      say((e as Error).message, true);
      return;
    }
    const step = (): void => {
      if (!playing) return;
      if (ep.done) {
        playing = false;
        say(`Episode: ${ep.outcome} after ${ep.steps} steps`);
        return;
      }
      try {
        ep.step(greedyAction(p, ep.state(), rng));
      } catch (e) {
        playing = false;
        say((e as Error).message, true);
        return;
      }
      draw();
      setTimeout(step, 40);
    };
    step();
  };
  // Real time: every frame the host runs its physics up to "now" and the page redraws.
  const loop = (t: number): void => {
    if (!playing) {
      host.tick();
      draw();
      opts.onFrame?.(t);
    }
    requestAnimationFrame(loop);
  };
  const first = Object.keys(worlds)[0];
  if (first === undefined) throw new Error("mountViewer: at least one world is required");
  loadWorld(first);
  const firstSpec = Object.keys(opts.specs)[0];
  if (firstSpec !== undefined) showSpec(firstSpec);
  requestAnimationFrame(loop);
  return {
    get playing() {
      return playing;
    },
    stopPlaying: () => {
      playing = false;
    },
    el,
  };
}
