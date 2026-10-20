// scripts/deploy-cloudflare.sh and scripts/smoke.sh, run for real against fakes: a stub `npx` on PATH stands in for
// wrangler, and a local HTTP server stands in for the Worker. No network, no Cloudflare, no real secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("..", import.meta.url).pathname;

function run(cmd: string, args: string[], env: Record<string, string>, cwd = repo): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

// A throwaway copy of the template folder: the deploy script cd's to its parent, so .deploy/ lands in the sandbox.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "wab-deploy-test-"));
  mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "src")); mkdirSync(join(dir, "node_modules")); mkdirSync(join(dir, "bin"));
  copyFileSync(join(repo, "scripts/deploy-cloudflare.sh"), join(dir, "scripts/deploy-cloudflare.sh"));
  writeFileSync(join(dir, "wrangler.toml"), 'name = "wab-test"\n');
  writeFileSync(join(dir, "src/worker.ts"), "export {};\n");
  // Fake wrangler (via npx): logs each call's argv to calls.log, swallows stdin, fails `secret put` for names in FAKE_FAIL.
  writeFileSync(join(dir, "bin/npx"), `#!/usr/bin/env bash
shift 2  # --no-install wrangler
echo "$*" >> "${dir}/calls.log"
case "$1" in
  whoami) exit 0 ;;
  deploy) echo "Deployed https://wab-test.example.workers.dev"; exit 0 ;;
  secret) cat >/dev/null; [[ " \${FAKE_FAIL:-} " == *" $3 "* ]] && exit 1; exit 0 ;;
esac
exit 0
`);
  chmodSync(join(dir, "bin/npx"), 0o755);
  // Fake cf-api-deploy.mjs for --self-provision: init writes bridge tokens (+ Meta values from env), provision succeeds.
  writeFileSync(join(dir, "scripts/cf-api-deploy.mjs"), `import { writeFileSync, appendFileSync } from "node:fs";
const a = process.argv.slice(2); const f = a[a.indexOf("--secrets-file") + 1];
if (a[0] === "init") { writeFileSync(f, "SETUP_NONCE=n0nce\\nMCP_TOKEN=t\\n", { mode: 0o600 });
  for (const n of ["WA_APP_SECRET", "WA_ACCESS_TOKEN"]) if (process.env[n]) appendFileSync(f, n + "=" + process.env[n] + "\\n"); }
if (a[0] === "provision") console.log("provisioned (200)");
`);
  const env = { PATH: `${join(dir, "bin")}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: "", WA_APP_SECRET: "", WA_ACCESS_TOKEN: "" };
  return { dir, env, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const deploy = (s: ReturnType<typeof sandbox>, args: string[], env: Record<string, string> = {}) =>
  run("bash", [join(s.dir, "scripts/deploy-cloudflare.sh"), ...args], { ...s.env, ...env }, s.dir);

const FAKE_A = "fake-app-value-111", FAKE_B = "fake-access-value-222";

test("deploy: skipped Meta secrets -> non-zero exit, names listed, no Done line", async () => {
  const s = sandbox();
  try {
    const r = await deploy(s, []);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /required secrets were NOT set: WA_APP_SECRET WA_ACCESS_TOKEN/);
    assert.doesNotMatch(r.out, /^Done\./m);
  } finally { s.done(); }
});

test("deploy: all secrets set -> exit 0 with Done line, values never printed", async () => {
  const s = sandbox();
  try {
    const r = await deploy(s, [], { WA_APP_SECRET: FAKE_A, WA_ACCESS_TOKEN: FAKE_B });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Done\. Worker: https:\/\/wab-test\.example\.workers\.dev/m);
    for (const n of ["MCP_TOKEN", "ADMIN_TOKEN", "CRON_SECRET", "WA_VERIFY_TOKEN", "WA_APP_SECRET", "WA_ACCESS_TOKEN"]) assert.match(r.out, new RegExp(`  set ${n}\\b`));
    assert.ok(!(r.out + r.err).includes(FAKE_A) && !(r.out + r.err).includes(FAKE_B));
    assert.ok(!readFileSync(join(s.dir, "calls.log"), "utf8").includes(FAKE_A), "secret value must not be in argv");
  } finally { s.done(); }
});

test("deploy: a failed `secret put` -> non-zero exit naming that secret", async () => {
  const s = sandbox();
  try {
    const r = await deploy(s, [], { WA_APP_SECRET: FAKE_A, WA_ACCESS_TOKEN: FAKE_B, FAKE_FAIL: "CRON_SECRET" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /FAILED to set CRON_SECRET/);
    assert.match(r.err, /required secrets were NOT set: CRON_SECRET$/m);
    assert.doesNotMatch(r.out, /^Done\./m);
  } finally { s.done(); }
});

test("deploy: --no-secrets is an explicit opt-out and still exits 0", async () => {
  const s = sandbox();
  try { assert.equal((await deploy(s, ["--no-secrets"])).code, 0); } finally { s.done(); }
});

test("deploy: --set-secret with nothing to set -> non-zero exit", async () => {
  const s = sandbox();
  try {
    const r = await deploy(s, ["--set-secret", "WA_APP_SECRET"]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /NOT set: WA_APP_SECRET/);
  } finally { s.done(); }
});

test("deploy --self-provision: skipped Meta secret -> non-zero exit, no 'Setup is locked' Done line", async () => {
  const s = sandbox();
  try {
    const r = await deploy(s, ["--self-provision"], { WA_APP_SECRET: FAKE_A });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /NOT set: WA_ACCESS_TOKEN$/m);
    assert.doesNotMatch(r.out, /Done\. Setup is locked/);
  } finally { s.done(); }
});

test("deploy --self-provision: everything set -> exit 0 and 'Done. Setup is locked'", async () => {
  const s = sandbox();
  try {
    const r = await deploy(s, ["--self-provision"], { WA_APP_SECRET: FAKE_A, WA_ACCESS_TOKEN: FAKE_B });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Done\. Setup is locked/);
    assert.ok(!(r.out + r.err).includes(FAKE_A));
  } finally { s.done(); }
});

// ---- scripts/smoke.sh ----
const EXPECTED: Record<string, number> = { "/": 200, "/api/health": 200, "/api/admin": 401, "/mcp": 401, "/api/webhook:GET": 403, "/api/cron/retry-wakes": 401, "/api/webhook:POST": 401, "/api/admin/meta-setup": 404, "/api/admin/media-selftest": 404, "/api/admin/voice-selftest": 404, "/api/admin/conversations/c_00000000000000000000": 401 };
async function fakeWorker(badRequests: number) {
  let seen = 0;
  const srv = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const key = path === "/api/webhook" ? `${path}:${req.method}` : path;
    res.statusCode = seen++ < badRequests ? 404 : (EXPECTED[key] ?? 500);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => srv.close(r)) };
}
const smoke = (url: string, env: Record<string, string>) => run("bash", [join(repo, "scripts/smoke.sh"), url], env);

test("smoke: passes first time against a healthy Worker", async () => {
  const w = await fakeWorker(0);
  try {
    const r = await smoke(w.url, { SMOKE_RETRY_SECONDS: "0" });
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal((r.out.match(/^PASS /gm) ?? []).length, 11);
  } finally { await w.close(); }
});

test("smoke: retries a Worker that is not ready yet, then passes", async () => {
  const w = await fakeWorker(2); // first two requests answer 404, like a route that is still propagating
  try {
    const r = await smoke(w.url, { SMOKE_RETRY_SECONDS: "30", SMOKE_RETRY_MAX_DELAY: "1" });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /retry GET \/ in /);
    assert.match(r.out, /PASS GET \/ \(200, after 3 attempts\)/);
  } finally { await w.close(); }
});

test("smoke: gives up after the retry budget with a clear message", async () => {
  const w = await fakeWorker(1_000_000); // always 404: only the meta-setup check (expects 404) can pass
  try {
    const r = await smoke(w.url, { SMOKE_RETRY_SECONDS: "2", SMOKE_RETRY_MAX_DELAY: "1" });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL GET \/ \(expected 200, got 404; \d+ attempt\(s\), retry budget of 2s used up\)/);
    assert.match(r.err, /SMOKE FAILED: 8 check\(s\) still wrong after retrying for up to 2s \(SMOKE_RETRY_SECONDS\)/);
    assert.match(r.err, /^  - GET \/$/m);
    assert.match(r.out, /^PASS GET \/api\/admin\/meta-setup/m);
  } finally { await w.close(); }
});

test("smoke: rejects a malformed SMOKE_RETRY_SECONDS", async () => {
  const r = await smoke("http://127.0.0.1:9", { SMOKE_RETRY_SECONDS: "3m" });
  assert.equal(r.code, 2);
});
