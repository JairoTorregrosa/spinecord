// Loads a world from a JSON file (bun/node). In a browser: fetch the JSON and call parseWorld.
import { readFile } from "node:fs/promises";
import { parseWorld, type WorldConfig } from "./world";

export async function loadWorldFile(path: string): Promise<WorldConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`world file: cannot read ${path}: ${(e as Error).message}`, { cause: e });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`world file: ${path} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  return parseWorld(json);
}
