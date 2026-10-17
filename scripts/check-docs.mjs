// Documentation check (no network, no dependencies): every relative Markdown link and anchor in tracked *.md files must resolve,
// docs/index.md must link every other page under docs/, and every README translation under docs/readme/ must stay
// structurally identical to README.md (same code blocks, links and inline code; language bar complete; RTL languages marked). Run with `npm run docs:check` (also part of `npm run check`).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "*.md"], { encoding: "utf8" }).split("\n").filter(Boolean);
const slug = (h) => h.trim().toLowerCase().replace(/[`*_~]/g, "").replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\p{M}\s-]/gu, "").replace(/\s/g, "-");
const anchorsOf = (path) => {
  const out = new Set();
  let fence = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[1]));
  }
  return out;
};
const problems = [];
for (const f of files) {
  let fence = false;
  readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [rawPath, anchor] = target.split("#");
      const path = rawPath === "" ? f : normalize(join(dirname(f), rawPath));
      if (!existsSync(path)) { problems.push(`${f}:${i + 1}: missing file ${target}`); continue; }
      if (anchor && path.endsWith(".md") && !anchorsOf(path).has(anchor)) problems.push(`${f}:${i + 1}: missing anchor #${anchor} in ${path}`);
    }
  });
}
const index = readFileSync("docs/index.md", "utf8");
for (const f of files.filter((x) => x.startsWith("docs/") && x !== "docs/index.md")) {
  if (!index.includes(f.slice("docs/".length))) problems.push(`docs/index.md does not link ${f}`);
}
// README translations (docs/readme/README_<code>.md): structure must match the English README.
const LANGS = ["zh", "zh-TW", "ja", "ko", "tr", "ru", "vi", "th", "de", "es", "fr", "uk", "pl", "pt-BR", "ar", "fa", "id", "it", "el"];
const read = (f) => readFileSync(f, "utf8");
const fences = (t) => [...t.matchAll(/^```[^\n]*\n[\s\S]*?\n```$/gm)].map((m) => m[0]);
const outsideFences = (t) => t.replace(/^```[^\n]*\n[\s\S]*?\n```$/gm, "");
const inlineCode = (t) => [...outsideFences(t).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).sort();
const barRe = /README_[A-Za-z-]+\.md$|(^|\/)README\.md$/;
const linkSet = (t, base) => {
  const out = [];
  for (const m of outsideFences(t).matchAll(/\]\(([^)\s]+)\)/g)) {
    const [rawPath, anchor] = m[1].split("#");
    if (/^(https?:|mailto:)/.test(m[1])) { out.push(m[1]); continue; }
    const path = rawPath === "" ? "" : normalize(join(base, rawPath));
    if (barRe.test(path)) continue;
    out.push(anchor && path ? `${path}#${anchor}` : path ? path : "");
  }
  return out.filter((x) => x !== "").sort();
};
const readme = read("README.md");
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
for (const code of LANGS) {
  const f = `docs/readme/README_${code}.md`;
  if (!existsSync(f)) { problems.push(`missing translation ${f}`); continue; }
  if (!readme.includes(`(${f})`)) problems.push(`README.md language bar does not link ${f}`);
  const t = read(f);
  if (!same(fences(t), fences(readme))) problems.push(`${f}: code blocks differ from README.md`);
  if (!same(inlineCode(t), inlineCode(readme))) problems.push(`${f}: inline code spans differ from README.md`);
  if (!same(linkSet(t, "docs/readme"), linkSet(readme, "."))) problems.push(`${f}: link targets differ from README.md`);
  if (!t.includes("wabbot-dev/wab-bot](https://github.com/wabbot-dev/wab-bot)")) problems.push(`${f}: official-source notice link missing`);
  if (!t.includes("[!IMPORTANT]") || !t.includes("[!NOTE]")) problems.push(`${f}: IMPORTANT/NOTE blocks missing`);
  if ((code === "ar" || code === "fa") !== t.includes('dir="rtl"')) problems.push(`${f}: dir="rtl" must be present for ar and fa only`);
  for (const other of LANGS.filter((c) => c !== code)) if (!t.includes(`(README_${other}.md)`)) problems.push(`${f}: language bar misses ${other}`);
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`docs: ${files.length} Markdown files, links, anchors and the docs index are consistent`);
