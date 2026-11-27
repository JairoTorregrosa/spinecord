import { expect, test } from "bun:test";
import * as THREE from "three";
import { Stillness } from "./still";

test("a frame is drawn only when something it would draw changed", () => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc9c6bf);
  scene.fog = new THREE.Fog(0xc9c6bf, 500, 2000);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const box = new THREE.Mesh(geo, mat);
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  hidden.visible = false;
  const light = new THREE.DirectionalLight(0xffffff, 2);
  scene.add(box, hidden, light);
  const cam = new THREE.PerspectiveCamera(42, 1, 0.5, 8000);
  const s = new Stillness();
  const look = (extra: number[] = [1280, 720]) => {
    scene.updateMatrixWorld();
    cam.updateMatrixWorld();
    return s.changed(scene, [cam], extra);
  };
  expect(look()).toBe(true); // the first frame
  expect(look()).toBe(false); // nothing moved
  const changes: [string, () => void][] = [
    ["an object moves", () => box.position.set(1, 0, 0)],
    ["it turns", () => (box.rotation.y = 0.3)],
    ["its colour", () => mat.color.set(0x00ff00)],
    ["its emissive (an LED)", () => mat.emissive.set(0x220000)],
    ["its opacity (see-through)", () => ((mat.transparent = true), (mat.opacity = 0.25))],
    ["its material needs a new program", () => (mat.needsUpdate = true)],
    ["another material", () => (box.material = new THREE.MeshStandardMaterial())],
    ["its geometry's points (the rays)", () => (geo.attributes.position!.needsUpdate = true)],
    ["its draw range (the trail)", () => geo.setDrawRange(0, 2)],
    ["a hidden object shows", () => (hidden.visible = true)],
    ["it hides again", () => (hidden.visible = false)],
    ["the light", () => (light.intensity = 1)],
    ["the fog", () => ((scene.fog as THREE.Fog).far = 900)],
    ["the camera moves", () => cam.position.set(0, 10, 30)],
    ["the camera's lens", () => ((cam.aspect = 2), cam.updateProjectionMatrix())],
    ["the camera's layers", () => cam.layers.enable(1)],
    ["a new object", () => scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))],
  ];
  for (const [what, change] of changes) {
    change();
    expect([what, look()]).toEqual([what, true]);
    expect([what, look()]).toEqual([what, false]);
  }
  const tex = new THREE.Texture();
  (box.material as THREE.MeshStandardMaterial).map = tex;
  expect(look()).toBe(true);
  tex.needsUpdate = true; // a screen drawn again (the brick's LCD, the phone's face)
  expect(look()).toBe(true);
  expect(look()).toBe(false);
  expect(look([1600, 1000])).toBe(true); // the canvas resized
  expect(look([1600, 1000])).toBe(false);
  s.reset(); // the context came back
  expect(look([1600, 1000])).toBe(true);
});
