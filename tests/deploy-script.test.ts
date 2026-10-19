// Deploy script workers.dev subdomain step, run against a fake `wrangler` (via a fake `npx`): no Cloudflare login, no network.
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
  deploy*) echo "wrangler-deploy" >> "${dir}/order.log"; echo "Deployed https://wab-test-bot.example-sub.workers.dev" ;;
esac
exit 0
`);
  chmodSync(join(dir, "bin/npx"), 0o755);
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, ...extra, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: "fake-" + rnd() };
    delete e.WA_APP_SECRET; delete e.WA_ACCESS_TOKEN; delete e.CLOUDFLARE_ACCOUNT_ID;
    return { ...e, ...extra };
  };
  const puts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { dir, env, puts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const deploy = (sb: ReturnType<typeof sandbox>, args: string[], extra: Record<string, string> = {}) =>
  run("bash", ["scripts/deploy-cloudflare.sh", "--name", "wab-test-bot", ...args], { cwd: sb.dir, env: sb.env(extra) });

/** Replace the API script with a stub that records its arguments (and can fail), to see when and how the subdomain step is called. */
function stubApiScript(sb: ReturnType<typeof sandbox>) {
  writeFileSync(join(sb.dir, "scripts/cf-api-deploy.mjs"), `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(sb.dir, "order.log"))}, "api " + process.argv.slice(2).join(" ") + "\\n");
if (process.env.STUB_FAIL) { console.error("ERROR: stub says no"); process.exit(1); }
`);
  return () => (existsSync(join(sb.dir, "order.log")) ? readFileSync(join(sb.dir, "order.log"), "utf8").split("\n").filter(Boolean) : []);
}

test("deploy: with token + account id the workers.dev subdomain is ensured BEFORE wrangler deploy; --subdomain is passed on", async () => {
  const sb = sandbox();
  try {
    const order = stubApiScript(sb);
    const r = await deploy(sb, ["--subdomain", "acme-wa", "--no-secrets"], { CLOUDFLARE_ACCOUNT_ID: "acc" + rnd() });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(order(), ["api subdomain --name wab-test-bot --subdomain acme-wa", "wrangler-deploy"]);
    assert.ok(!(r.out + r.err).includes(sb.env().CLOUDFLARE_API_TOKEN!), "token printed");
  } finally { sb.cleanup(); }
});

test("deploy: a failing subdomain step stops the deploy with a clear message (nothing deployed)", async () => {
  const sb = sandbox();
  try {
    const order = stubApiScript(sb);
    const r = await deploy(sb, [], { CLOUDFLARE_ACCOUNT_ID: "acc" + rnd(), STUB_FAIL: "1" });
    assert.equal(r.code, 1);
    assert.match(r.err, /could not make sure the account has a workers\.dev subdomain/);
    assert.deepEqual(order(), ["api subdomain --name wab-test-bot"]);
    assert.deepEqual(sb.puts(), []);
  } finally { sb.cleanup(); }
});

test("deploy: without an account id the subdomain step is skipped with a note, and a bad --subdomain is refused", async () => {
  const sb = sandbox();
  try {
    const order = stubApiScript(sb);
    const r = await deploy(sb, ["--no-secrets"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /CLOUDFLARE_ACCOUNT_ID is not set: not checking the workers\.dev subdomain/);
    assert.deepEqual(order(), ["wrangler-deploy"]);
    const bad = await deploy(sb, ["--subdomain", "Bad_Name"]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--subdomain must be/);
  } finally { sb.cleanup(); }
});
