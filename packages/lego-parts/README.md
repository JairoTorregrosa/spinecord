# @spinecord/lego-parts

This package maps the real LEGO parts an EV3 robot is built from, stored as data. The human-and-agent guide is [`docs/lego-parts.md`](../../docs/lego-parts.md).

| File | What | How it is made |
|---|---|---|
| `data/units.json` | the grid: module, plate, brick, holes, axles, LDU | by hand, sourced |
| `data/electronics.json` | brick, motors, sensors, beacon, battery, cables: ids, mass, ports and outputs in the LDraw frame | by hand, sourced; positions checked against the geometry by the test |
| `data/rolling.json` | rims, tyres, tracks, sprockets, caster | by hand; diameters from the geometry |
| `data/structural.json` | beams, frames, axles, pins, connectors | by hand |
| `data/builds.json` | Education driving base, TRACK3R, Tank Bot | by hand, sourced |
| `data/ldraw-geometry.json` | per LDraw part: bounding box, triangles, Technic holes, named sub-parts | `bun tools/extract-ldraw.ts --ldraw <unzipped complete.zip>` |
| `data/ldraw-models.json` | placements read from an LDraw model (TRACK3R) | `bun tools/extract-ldraw.ts --ldraw <dir> --model <mpd> --key <k> --source <url> [--section <name>]` |
| `data/sets.json` | complete inventories of 31313, 45544, 45560 | `bun tools/inventories.ts --csv <Rebrickable downloads>` |

The LDraw library is not in the repo. Download <https://library.ldraw.org/library/updates/complete.zip> into a temporary folder.

The geometry was read from the LDraw parts library, © its authors, licensed CC BY 4.0 (a few files CC BY 2.0; see each part's `license`): <https://library.ldraw.org>. The TRACK3R placements come from Philippe Hurbain's model, CC BY 2.0.

## Drawing real parts: LDraw meshes measured (2026-11-27, library 2026-10, three.js r187)

Method: each part is packed with all its sub-files into one MPD, as three.js `utils/packLDrawModel.mjs` does (that script also prepends `LDConfig.ldr`, which is 66 KB raw / 9.5 KB gzip and is counted separately here). Gzip is level 9. Triangles count type-3 lines plus 2 per type-4 line. LDrawLoader in the browser produced the same counts: 28,177 / 12,830 against 28,155 / 12,830 static. The four columns are:

- **full**: the part as published.
- **no lines**: edge and conditional lines (types 2 and 5) dropped. This changes bytes and draw calls, not triangles.
- **low-res**: no lines, plus the `48/` primitives swapped for their 16-segment version and every primitive that has an `8/` version swapped for it.
- **+plain**: low-res, plus printed sub-parts (`…p01`) swapped for their unprinted version.

Every cell reads triangles / raw KB / gzip KB.

| Part | full | no lines | low-res | +plain |
|---|---|---|---|---|
| 95646 brick (AA cover) | 28155 / 298 / 50.9 | 28155 / 262 / 45.3 | 23347 / 256 / 44.5 | 21573 / 203 / 34.8 |
| 95646c01 brick + battery | 28755 / 342 / 58.4 | 28755 / 290 / 50.5 | 23105 / 281 / 49.2 | 21331 / 228 / 39.5 |
| 95658 large motor | 12830 / 183 / 28.9 | 12830 / 148 / 23.7 | 8702 / 120 / 20.4 | 8702 / 120 / 20.4 |
| 99455 medium motor | 6758 / 115 / 18.3 | 6758 / 100 / 15.9 | 4978 / 92 / 15.0 | same |
| 95648 touch | 3958 / 123 / 20.2 | 3958 / 101 / 16.6 | 3442 / 95 / 15.9 | same |
| 95650 colour | 4345 / 139 / 21.8 | 4345 / 107 / 17.3 | 3629 / 100 / 16.5 | same |
| 99380 gyro | 3530 / 105 / 17.6 | 3530 / 89 / 14.8 | 3068 / 85 / 14.2 | same |
| 95652 ultrasonic | 9748 / 261 / 40.9 | 9748 / 193 / 31.3 | 6556 / 162 / 27.3 | same |
| 95654 infrared | 6531 / 183 / 29.9 | 6531 / 140 / 23.5 | 4931 / 123 / 21.5 | same |
| 72156 beacon | 7874 / 114 / 18.4 | 7874 / 96 / 15.7 | 6098 / 89 / 15.1 | 6098 / 89 / 15.0 |
| 95656 battery | 4524 / 88 / 14.0 | 4524 / 65 / 10.3 | 2830 / 57 / 9.4 | same |
| 11145 / 11146 / 11147 cables | 3510–4410 / 54–56 / 7.7–7.9 | – / 36–38 / 5.4–5.6 | 2854–3634 / 33–35 / 5.2–5.3 | same |
| 41897 tyre 56 × 28 | 7008 / 56 / 8.7 | 7008 / 41 / 6.7 | 5568 / 27 / 4.6 | same |
| 56908 rim 43.2 × 26 | 6874 / 102 / 16.7 | 6874 / 70 / 12.3 | 4042 / 45 / 8.0 | same |
| 44309 tyre 43.2 × 22 | 4864 / 49 / 8.6 | 4864 / 39 / 7.2 | 2624 / 20 / 4.0 | same |
| 56145 rim 30.4 × 20 | 2922 / 66 / 10.0 | 2922 / 37 / 6.2 | 2910 / 36 / 5.9 | same |
| 44771 tyre 68.8 × 36 | 6096 / 47 / 7.9 | 6096 / 34 / 6.2 | 4656 / 22 / 4.2 | same |
| 15038 rim 56 × 34 | 6738 / 110 / 17.9 | 6738 / 80 / 13.7 | 3858 / 53 / 9.6 | same |
| 57519 sprocket | 8828 / 51 / 8.4 | 8828 / 39 / 6.6 | 5812 / 34 / 6.0 | same |
| 88323 tread link | 1380 / 59 / 9.1 | 1380 / 47 / 7.4 | 1052 / 40 / 6.5 | same |
| 53992-f1 rubber track | 1272 / 9 / 1.9 | 1272 / 8 / 1.6 | same | same |
| 99948 steel ball | 1152 / 29 / 3.5 | 1152 / 10 / 1.7 | 32 / 2 / 0.5 | same |
| 92911 ball receptacle | 1790 / 41 / 6.7 | 1790 / 29 / 5.1 | 1466 / 25 / 4.5 | same |

**One bundle with shared sub-files** (each primitive stored once):

| Bundle | full | no lines | low-res + plain |
|---|---|---|---|
| 14 electronic parts | 949 KB raw, 158 KB gzip, 128,798 triangles | 752 KB, 129 KB | 642 KB, 111 KB, 96,792 triangles |
| 11 rolling parts | 473 KB, 76 KB, 48,924 triangles | 315 KB, 54 KB | 229 KB, 39 KB, 33,292 triangles |
| all 25 parts | 1,337 KB, 221 KB, 177,722 triangles | 1,002 KB, 172 KB | 819 KB, 143 KB, 130,084 triangles |

Add 9.5 KB gzip for `LDConfig.ldr`, or a few hundred bytes if only the colours used are shipped.

What the simplifications do:

- None of these parts has a stud (0 `stud*.dat` references), so there is no stud detail to drop.
- Dropping lines removes 20–40 % of the bytes and all of the line draw work (32,816 line segments for the brick and the large motor), but no triangles.
- `8/` primitives remove a third of the triangles on round parts, but they open visible seams where an 8-segment primitive meets 16-segment geometry. A white wedge shows on the large motor's side in the shot.
- The steel ball drops to 32 triangles, which is a faceted polygon.
- Swapping printed sub-parts saves 8 KB gzip on the brick, but it removes the port letters, the EV3 logo and the button colours. Those are exactly what a person reads.

A robot of one brick, two large motors, one medium motor, three sensors and two wheels (tyre plus rim) comes to about 100,000 triangles at full detail. On the Jetson's software WebGL the brick and the large motor loaded and drew in 1.4–1.7 s.

Shots (prototype outside the repo, three.js `LDrawLoader`, headless Chrome on the Jetson):

- `/home/jairo/.t3/userdata/attachments/twinview/H/ldraw-brick-largemotor-full.png`
- `/home/jairo/.t3/userdata/attachments/twinview/H/ldraw-brick-largemotor-lowres-plain.png`
- `/home/jairo/.t3/userdata/attachments/twinview/H/ldraw-brick-top-ports.png`
- `/home/jairo/.t3/userdata/attachments/twinview/H/ldraw-brick-sensor-end.png`: the motor-port end, labels `PC D C B A`. This confirms the port order in `electronics.json`.

The shots show the white shell tinted yellow. A part loaded on its own takes LDraw colour 16, the "main colour", so give each part its colour (15 white, 71 light grey) when placing it.

**Licence.** The LDraw library is "licensed by the Creative Commons Attribution License 2.0 (CC BY 2.0) and Creative Commons Attribution License 4.0 International (CC BY 4.0)" (CAreadme.txt). Its terms: "You are free: To distribute, remix, adapt, and build upon the material in any medium or format, so long as attribution, as specified by the license, is given to the creator. To make commercial use of the CA approved LDraw Parts Library". The attribution must "1. Name the creator 2. Provide a URL for the work 3. Name the license 4. Provide a URL for the license 5. Note whether the work has been modified". Items 1–4 are in each file's header (`0 Author:`, `0 !LICENSE`). Item 5 is ours: packing and simplifying are modifications.

So shipping packed or converted meshes is allowed, with an attribution page listing the authors of the parts shipped, linking <https://library.ldraw.org> and CC BY 4.0 / 2.0, and saying the files were packed and simplified. The CAreadme says rendered images are not derivative works. Converted part geometry is.

Every packed file of the 25 parts carries `Licensed under CC BY 4.0`, except one sub-file of the beacon, which is `CC BY 2.0 and CC BY 4.0`.

### Recommendation

Draw the twin from procedural shapes built from this map's exact numbers, and use real LDraw meshes only where recognition depends on them:

1. **Procedural, from `ldraw-geometry.json` and `units.json`: everything structural and everything that rolls.** Beams, frames, axles, rims, tyres and tracks are boxes and cylinders on the 8 mm grid; their exact size and hole positions are in the data. They cost a few hundred triangles each, move cheaply, and the "real part, real size, grid position" rule holds by construction. Tyre and rim meshes cost 4–7k triangles each for detail nobody reads at robot scale.
2. **Real LDraw meshes, packed, lines dropped, `48/`→16 kept but no `8/` swap and no print swap: the brick, and the sensor types actually present.** These parts are what a person recognises (port letters, screen, eyes). Budget: brick 45 KB gzip / 28k triangles; each sensor 15–31 KB / 3.5–10k. All 14 electronic parts come to 129 KB gzip; a typical robot's set comes to about 80 KB.
3. **Large and medium motors: either option.** As LDraw meshes they cost 24 + 16 KB gzip and 12.8k + 6.8k triangles. Procedurally they are a box with the output hub at the exact feature position. Choose procedural if the page's triangle budget is tight (the twin may show several robots).

Load meshes lazily, after the scene first draws. Ship a generated `ATTRIBUTION.md` with the bundle.
