// The PR-readiness check (scripts/ci/pr-readiness.mjs): pure verdicts against the real trusted PR template. No network, no GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateReadiness, readinessLines } from "../scripts/ci/pr-readiness.mjs";

const template = readFileSync(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");
const declarations = readinessLines(template).filter((l) => l.startsWith("- [ ] ")).map((l) => l.slice(6));
const body = (owner: string, checked: boolean[]) =>
  `## Summary\nx\n\n## Author readiness\n\nHuman owner: ${owner}\n\n` +
  declarations.map((d, i) => `- [${checked[i] ? "x" : " "}] ${d}`).join("\n") + "\n\n## Before merge\n- [ ] later\n";

test("template has exactly three readiness declarations", () => assert.equal(declarations.length, 3));
test("draft is pending even with an empty body", () => assert.equal(evaluateReadiness({ draft: true, body: "" }, template).state, "pending"));
test("filled owner and three ticks succeed", () => assert.equal(evaluateReadiness({ body: body("@octocat", [true, true, true]) }, template).state, "success"));
test("missing tick fails", () => assert.equal(evaluateReadiness({ body: body("@octocat", [true, false, true]) }, template).state, "failure"));
test("empty or placeholder owner fails", () => {
  assert.equal(evaluateReadiness({ body: body("", [true, true, true]) }, template).state, "failure");
  assert.equal(evaluateReadiness({ body: body("some person", [true, true, true]) }, template).state, "failure");
});
test("empty body fails", () => assert.equal(evaluateReadiness({ body: null }, template).state, "failure"));
test("ticks inside HTML comments or code fences do not count", () => {
  const hidden = `## Author readiness\n\nHuman owner: @octocat\n\n<!--\n${declarations.map((d) => `- [x] ${d}`).join("\n")}\n-->\n`;
  assert.equal(evaluateReadiness({ body: hidden }, template).state, "failure");
  const fenced = `## Author readiness\n\nHuman owner: @octocat\n\n\`\`\`\n${declarations.map((d) => `- [x] ${d}`).join("\n")}\n\`\`\`\n`;
  assert.equal(evaluateReadiness({ body: fenced }, template).state, "failure");
});
test("an edited declaration text fails (must match the current template)", () => {
  const edited = body("@octocat", [true, true, true]).replace(declarations[0]!, "I looked at it");
  assert.equal(evaluateReadiness({ body: edited }, template).state, "failure");
});
