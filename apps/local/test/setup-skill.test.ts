// The setup skill (.claude/skills/setup-spinecord/SKILL.md) is written in Simplified Technical English: a sentence
// in a list item (a procedure step) has at most 20 words, any other sentence at most 25. Frontmatter, headings,
// tables and code blocks are not prose and are skipped. Inline code and a link's text count as one word each.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(import.meta.dir, "..", "..", "..", ".claude", "skills", "setup-spinecord", "SKILL.md");

/** The words of one sentence: inline code is one word, a link is its text. */
export function words(sentence: string): string[] {
  return sentence
    .replaceAll(/`[^`]*`/g, "CODE")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** Sentences end at . ! or ? followed by a space or the end of the line, outside inline code. */
export function sentences(line: string): string[] {
  const masked = line.replaceAll(/`[^`]*`/g, (c) => c.replaceAll(/[.!?]/g, "_"));
  const out: string[] = [];
  let start = 0;
  for (const m of masked.matchAll(/[.!?](?=\s|$)/g)) {
    out.push(line.slice(start, m.index + 1));
    start = m.index + 1;
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter((s) => words(s).length > 0);
}

/** Every prose sentence with its line number, its limit and its length. */
export function check(text: string): { line: number; limit: number; count: number; sentence: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { line: number; limit: number; count: number; sentence: string }[] = [];
  let fence = false;
  let front = lines[0] === "---";
  lines.forEach((raw, i) => {
    if (i > 0 && front && raw === "---") return void (front = false);
    if (front) return;
    if (/^\s*```/.test(raw)) return void (fence = !fence);
    if (fence || /^\s*(#|\|)/.test(raw) || raw.trim() === "") return;
    const item = /^\s*(\d+\.|-)\s+/.exec(raw);
    const limit = item ? 20 : 25;
    for (const s of sentences(item ? raw.slice(item[0].length) : raw))
      out.push({ line: i + 1, limit, count: words(s).length, sentence: s });
  });
  return out;
}

test("the counter: inline code and links are one word, sentences split outside code", () => {
  expect(words("Run `bun apps/local/main.ts --doctor --twin` in [the folder](x.md).")).toHaveLength(5);
  expect(sentences("Run `a.b c`. Then stop.")).toEqual(["Run `a.b c`.", "Then stop."]);
  const long = Array.from({ length: 21 }, () => "go").join(" ");
  expect(check(`- ${long}.`)[0]).toMatchObject({ limit: 20, count: 21 });
  expect(check(`${long}.`)[0]).toMatchObject({ limit: 25, count: 21 });
  expect(check(`---\nname: x\n---\n\`\`\`\n${long}\n\`\`\`\n| ${long} |`)).toEqual([]);
});

test("every sentence of the setup skill is within its STE limit", () => {
  const text = readFileSync(SKILL, "utf8");
  const sentencesFound = check(text);
  expect(sentencesFound.length).toBeGreaterThan(100);
  const over = sentencesFound
    .filter((s) => s.count > s.limit)
    .map((s) => `${s.line}: ${s.count}/${s.limit} ${s.sentence}`);
  expect(over).toEqual([]);
});
