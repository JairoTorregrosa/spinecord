# Performance

What a person waits for, measured before and after each change. One machine for every number: Apple M1 Pro, macOS 27.2, bun 1.3.14, Chrome 158.0.8127.89 headless; medians of 5 runs taken one after the other (2026-11-27). "Weak GPU" is the same page drawn by SwiftShader (a CPU renderer) with Chrome's CPU slowed 4x: a stand-in for an integrated GPU, not a measurement of one. Taken between 16:15 and 17:05 Bogotá time on a Mac that other agents shared: another spinecord server ran from 16:16, and a participant's end-to-end test (a server, a browser, Claude Code) ran during the afternoon. So each before and after pair ran back to back from two worktrees of the same commits; the tool latency, run apart at first, moved by the machine's state alone (stop 0.66 ms, then 1.79 ms, with no change in its path) and is given here from the back-to-back pair.

| Metric | Command | Before | After | Ratio |
|---|---|---|---|---|
| view.js on the wire | `bun bench/page.ts` (`view_js_wire`) | 763,940 B | 212,054 B (gzip) | 3.6x smaller |
| page load on the wire, cold | `bun bench/page.ts` (`wire_cold`) | 893,602 B | 322,481 B | 2.8x smaller |
| page load on the wire, reload | `bun bench/page.ts` (`wire_reload`) | 893,602 B | 1,128 B (304s) | 790x smaller |
| frame time, robot still, weak GPU | `bun bench/page.ts --software --throttle 4` (`frame_idle`) | 183.3 ms (p95 233) | 16.7 ms (p95 16.8) | 11x |
| frame time, robot turning, weak GPU | same (`frame_drive`) | 216.6 ms | 200.0 ms | 1.08x, not changed |
| frame time, GPU, still and turning | `bun bench/page.ts` (`frame_idle`, `frame_drive`) | 16.7 ms | 16.7 ms | one vsync before and after |
| first frame with the robot, cold, GPU | `bun bench/page.ts` (`first_frame_cold`) | 300.6 ms | 300.4 ms | 1.0x |
| first frame with the robot, reload, GPU | same (`first_frame_reload`) | 206.3 ms | 204.8 ms | 1.0x |
| first frame with the robot, cold, weak GPU | `bun bench/page.ts --software --throttle 4` | 4,620 ms | 4,412 ms | 1.05x, noise |
| first frame with the robot, reload, weak GPU | same | 6,567 ms | 5,762 ms | 1.14x, under the 15 % bar: not claimed |
| server start to `ready` | `bun bench/page.ts` (`server_ready`) | 113.0 ms | 112.7 ms | not changed |
| server start to the page's first byte | same (`server_first_byte`) | 116.5 ms | 117.0 ms | not changed |
| update stream while driving | same (`stream_drive`) | not measured | 35 KB/s, 29 messages/s, largest 1,262 B | not changed |
| tool latency on the twin, p50 | `bun run bench`, then `bun run bench --compare <before.json> <after.json>` | read_all 0.10 ms, stop 2.80 ms, first motion 1.17 ms, MCP over stdio read_all 0.24 ms | read_all 0.10 ms, stop 2.79 ms, first motion 1.11 ms, stdio read_all 0.24 ms | not changed |
| server install, empty cache | `bun bench/install.ts --branch <branch>` (`install`) | 3.77 s, 112 packages, 403 MB | 0.70 s, 11 packages, 46 MB | 5.4x faster, 8.7x smaller |
| clone | `bun bench/install.ts` (`clone`) | 1.29 s, .git 3.4 MB | not changed | `--depth 1`: 1.30 s, .git 2.2 MB |

## What changed

- **The page's text is gzipped and revalidated by content** (`apps/local/src/http-cache.ts`): `Cache-Control: no-cache` with an ETag of the bytes, so a reload costs 304s and a server started from other sources is never served stale. The meshes go as they are (the page gunzips them). Over 127.0.0.1 the bytes cost no time: the first frame did not move.
- **A frame is drawn only when something it would draw changed** (`apps/twin-view/src/still.ts`): a signature of every visible object's place, material, geometry and texture, the cameras, the canvas and the robot camera's rectangle. The sensor rays and the tracks flag their buffers as changed only when they changed. Screenshots before and after at 1280x720 and 1600x1000, default and top view, still and turning: the still ones differ in 5 to 11 pixels (the clock), the turning one in 167 (the moment of the shot).
- **The server's install leaves out `--chat`'s Claude Agent SDK** (`apps/chat-sdk`): `--chat` without it ends the start with the command that adds it.

## Looked at and left

- First frame on a weak GPU: 5.6 s of an 8 s cold profile is three.js waiting on 16 shader programs to link, 1.2 s creating the WebGL context. `renderer.compileAsync` (parallel compile) gave no gain under SwiftShader; fewer program variants means changing the materials, so the look.
- Frame time while driving on a weak GPU: the render itself (MSAA, shadows, the robot camera's second pass). Each cut changes the look.
- Server start: 113 ms to `ready`, bundling the page included; a bundle cache would save a fraction of that.
- Lazy loading the chat panel: 24 KB of a 766 KB bundle (three.js is 621 KB).
- A shallow clone: 1.2 MB less, no time.
- Tool latency: under a millisecond in process; the rest is the physics' own time.
