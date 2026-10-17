// Deploy script exit codes, run against a fake `wrangler` (via a fake `npx`): no Cloudflare login, no network.
// Secret values are fake and built at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rnd = () => randomBytes(12).toString("hex");

type Run = { code: number; out: string; err: string };
const run = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) =>
  new Promise<Run>((res) => {
    const c = execFile(cmd, args, { ...opts, timeout: 120_000 }, (e, out, err) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err }));
    c.stdin?.end(); // not a terminal: the script's hidden prompts are skipped
  });

/** A throwaway copy of the script's folder layout with a fake npx/wrangler that records which secrets were put. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "wab-deploy-test-"));
  mkdirSync(join(dir, "scripts"));
  cpSync(join(ROOT, "scripts/deploy-cloudflare.sh"), join(dir, "scripts/deploy-cloudflare.sh"));
  writeFileSync(join(dir, "wrangler.toml"), 'name = "wab-test-bot"\n');
  mkdirSync(join(dir, "src")); writeFileSync(join(dir, "src/worker.ts"), "");
  mkdirSync(join(dir, "node_modules"));
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "puts.log");
  writeFileSync(join(dir, "bin/npx"), `#!/usr/bin/env bash
shift # --no-install
shift # wrangler
case "$1 $2" in
  "secret put") cat >/dev/null; echo "$3" >> "${log}" ;;
  deploy*) echo "Deployed https://wab-test-bot.example-sub.workers.dev" ;;
esac
exit 0
`);
  chmodSync(join(dir, "bin/npx"), 0o755);
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, ...extra, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: "fake-" + rnd() };
    delete e.WA_APP_SECRET; delete e.WA_ACCESS_TOKEN;
    return { ...e, ...extra };
  };
  const puts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { dir, env, puts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const deploy = (sb: ReturnType<typeof sandbox>, args: string[], extra: Record<string, string> = {}) =>
  run("bash", ["scripts/deploy-cloudflare.sh", "--name", "wab-test-bot", ...args], { cwd: sb.dir, env: sb.env(extra) });

test("deploy: skipped Meta secrets are named in a warning and exit 3, not 'Done' and 0", async () => {
  const sb = sandbox();
  try {
    const r = await deploy(sb, []);
    assert.equal(r.code, 3);
    assert.match(r.err, /WARNING: .*NOT set by this run: WA_APP_SECRET WA_ACCESS_TOKEN/);
    assert.doesNotMatch(r.out, /^Done\./m);
    assert.deepEqual(sb.puts(), ["MCP_TOKEN", "ADMIN_TOKEN", "CRON_SECRET", "WA_VERIFY_TOKEN"]);
  } finally { sb.cleanup(); }
});

test("deploy: --allow-missing-secrets keeps the warning but exits 0", async () => {
  const sb = sandbox();
  try {
    const r = await deploy(sb, ["--allow-missing-secrets"]);
    assert.equal(r.code, 0);
    assert.match(r.err, /WARNING: .*WA_APP_SECRET WA_ACCESS_TOKEN/);
  } finally { sb.cleanup(); }
});

test("deploy: only the secret that was skipped is named; with both supplied it says Done, exits 0 and echoes no value", async () => {
  const sb = sandbox();
  try {
    const app = "fake-app-" + rnd(), tok = "fake-token-" + rnd();
    const one = await deploy(sb, [], { WA_APP_SECRET: app });
    assert.equal(one.code, 3);
    assert.match(one.err, /NOT set by this run: WA_ACCESS_TOKEN\b/);
    assert.doesNotMatch(one.err, /NOT set by this run: .*WA_APP_SECRET/);
    const both = await deploy(sb, [], { WA_APP_SECRET: app, WA_ACCESS_TOKEN: tok });
    assert.equal(both.code, 0);
    assert.match(both.out, /^Done\. Worker: /m);
    assert.doesNotMatch(both.err, /WARNING/);
    for (const v of [app, tok]) assert.ok(!(one.out + one.err + both.out + both.err).includes(v), "secret value printed");
    assert.ok(sb.puts().includes("WA_APP_SECRET") && sb.puts().includes("WA_ACCESS_TOKEN"));
  } finally { sb.cleanup(); }
});
