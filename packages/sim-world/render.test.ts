import { test, expect, describe } from "bun:test";
import { inflateSync } from "node:zlib";
import { renderWorld, renderFirstPerson, hashImage, snapshotPNG, encodePNG, drawWorld, toBase64 } from "./render";
import { COLOR_RGB, COLOR } from "./world";
import { quietWorld, EXAMPLES } from "./testkit";

const px = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3),
];

describe("overhead render (pure RGBA buffer)", () => {
  test("size follows the arena and scale; y is flipped (world up = image up)", () => {
    const w = quietWorld();
    const img = renderWorld(w, { scale: 4, rays: false });
    expect([img.width, img.height]).toEqual([480, 360]);
    expect(px(img, 15 * 4, (90 - 75) * 4 + 12)).toEqual([...COLOR_RGB[COLOR.red]!]); // zone A (top-left in the world) is top-left in the image
    expect(px(img, 15 * 4, (90 - 15) * 4 + 12)).toEqual([...COLOR_RGB[COLOR.yellow]!]); // zone D, bottom-left
    expect(px(img, 75 * 4, (90 - 25) * 4)).toEqual([...COLOR_RGB[COLOR.black]!]); // the line
    expect(px(img, 60 * 4, (90 - 45) * 4)).toEqual([110, 110, 125]); // the obstacle
    expect(px(img, 43 * 4, (90 - 25) * 4)).toEqual([235, 140, 40]); // the robot body
  });
  test("deterministic hash; it changes when the robot moves or turns", () => {
    const a = quietWorld(),
      b = quietWorld();
    const h = hashImage(renderWorld(a));
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(hashImage(renderWorld(b))).toBe(h);
    b.advance(5, 5, 20);
    const h2 = hashImage(renderWorld(b));
    expect(h2).not.toBe(h);
    b.advance(-2, 2, 20);
    expect(hashImage(renderWorld(b))).not.toBe(h2);
    expect(hashImage(renderWorld(a, { rays: false }))).not.toBe(h);
  });
  test("the distance ray is drawn from the sensor to what it hits", () => {
    const w = quietWorld();
    const img = renderWorld(w, { scale: 4 });
    expect(px(img, 80 * 4, (90 - 25) * 4)).toEqual([230, 40, 60]); // on the ray, ahead of the robot, over the black line
  });
  test("every ray of the ultrasonic cone is drawn, not three: one 6 deg off the axis is there too", () => {
    const img = renderWorld(quietWorld(), { scale: 4 });
    const off = (6 * Math.PI) / 180;
    const [x, y] = [51 + 30 * Math.cos(off), 25 + 30 * Math.sin(off)];
    const near = [-1, 0, 1].flatMap((dx) =>
      [-1, 0, 1].map((dy) => px(img, Math.floor(x * 4) + dx, Math.floor((90 - y) * 4) + dy)),
    );
    expect(near).toContainEqual([230, 40, 60]);
  });
  test("a box that moved is drawn where it is now, not where the first picture had it", () => {
    const w = quietWorld();
    expect(px(renderWorld(w, { rays: false }), 60 * 4, (90 - 45) * 4)).toEqual([110, 110, 125]);
    w.moveObstacle(w.cfg.boxes[0]!.id, { x: 95, y: 60, w: 10, h: 10 });
    const img = renderWorld(w, { rays: false });
    expect(px(img, 60 * 4, (90 - 45) * 4)).not.toEqual([110, 110, 125]);
    expect(px(img, 100 * 4, (90 - 65) * 4)).toEqual([110, 110, 125]);
  });
  test("snapshotPNG is a valid PNG whose pixels decode back to the buffer", () => {
    const w = quietWorld(EXAMPLES.wallsMaze);
    const img = renderWorld(w, { scale: 2 });
    const png = snapshotPNG(w, { scale: 2 });
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
    expect([dv.getUint32(16), dv.getUint32(20), png[24], png[25]]).toEqual([300, 200, 8, 6]);
    const idatLen = dv.getUint32(33);
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLen)); // checks the zlib stream and its Adler-32
    expect(raw.length).toBe(200 * (1 + 300 * 4));
    for (const y of [0, 57, 199]) {
      expect(raw[y * 1201]).toBe(0);
      expect([...raw.subarray(y * 1201 + 1, y * 1201 + 1201)]).toEqual([
        ...img.data.subarray(y * 1200, y * 1200 + 1200),
      ]);
    }
    expect(Bun.hash.crc32(png.subarray(37, 41 + idatLen))).toBe(dv.getUint32(41 + idatLen));
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
  });
  test("toBase64 matches the platform encoder for every padding case", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 300]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
    expect(encodePNG({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) }).length).toBeGreaterThan(60);
  });
  test("drawWorld puts the same pixels on a canvas context and labels the points", () => {
    const w = quietWorld();
    const calls: string[] = [];
    let put: { data: Uint8ClampedArray; width: number } | null = null;
    const ctx = {
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: (id: { data: Uint8ClampedArray; width: number }) => {
        put = id;
      },
      fillText: (t: string) => {
        calls.push(t);
      },
      font: "",
      textAlign: "",
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
    const img = drawWorld(ctx, w, { scale: 3 });
    expect(hashImage({ width: img.width, height: img.height, data: put!.data })).toBe(
      hashImage(renderWorld(w, { scale: 3 })),
    );
    expect(calls).toEqual(["A", "B", "C", "D"]);
  });
  test("a silly scale fails loud", () => {
    expect(() => renderWorld(quietWorld(), { scale: 0 })).toThrow(/scale/);
  });
});

describe("first-person render", () => {
  test("sky on top, the black line on the floor ahead, and it changes when the robot turns", () => {
    const w = quietWorld();
    const img = renderFirstPerson(w);
    expect([img.width, img.height]).toEqual([160, 120]);
    expect(px(img, 80, 2)).toEqual([196, 222, 240]);
    expect(px(img, 80, 115)).toEqual([...COLOR_RGB[COLOR.black]!]); // driving along the line: it runs up the middle
    expect(px(img, 5, 115)).toEqual([...COLOR_RGB[COLOR.white]!]);
    const h = hashImage(img);
    w.advance(-3, 3, 20);
    expect(hashImage(renderFirstPerson(w))).not.toBe(h);
  });
  test("a low box is as tall as it is: the floor shows beyond it, below the horizon", () => {
    const wall = quietWorld(EXAMPLES.lineOval, { boxes: [{ id: "b", x: 80, y: 15, w: 5, h: 20 }] });
    const low = quietWorld(EXAMPLES.lineOval, { boxes: [{ id: "b", x: 80, y: 15, w: 5, h: 20, height_cm: 4 }] });
    // 29 cm ahead of the camera, 8 cm up: the top of a 4 cm box is 16 px under the horizon, a wall-high box's 24 px over it
    const grey = (img: ReturnType<typeof renderFirstPerson>, y: number) => {
      const [r, g, b] = px(img, 80, y);
      return r! < 125 && Math.abs(r! - g!) < 6 && b! > r!;
    };
    expect(grey(renderFirstPerson(wall), 64)).toBe(true);
    expect(grey(renderFirstPerson(low), 64)).toBe(false);
    expect(grey(renderFirstPerson(low), 80)).toBe(true);
  });
  test("a wall right in front fills the view", () => {
    const w = quietWorld();
    w.advance(200, 200, 25);
    const img = renderFirstPerson(w);
    const [r, g, b] = px(img, 80, 60);
    expect(b).toBeGreaterThan(r!);
    expect(px(img, 80, 60)).toEqual(px(img, 20, 60));
    expect(g).toBeGreaterThan(100);
  });
});
