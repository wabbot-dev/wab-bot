// scripts/smoke.sh retries and exit codes, run against a fake Worker on 127.0.0.1 (no Cloudflare, no network beyond loopback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Run = { code: number; out: string; err: string };
const run = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) =>
  new Promise<Run>((res) => {
    const c = execFile(cmd, args, { ...opts, timeout: 120_000 }, (e, out, err) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err }));
    c.stdin?.end(); // not a terminal: the script's hidden prompts are skipped
  });

/** A fake Worker answering what scripts/smoke.sh expects; the first `failFirst` requests get a 503 (a Worker that is still propagating). */
async function fakeWorker(opts: { failFirst?: number; health?: number } = {}) {
  let n = 0;
  const expected: Record<string, number> = {
    "GET /": 200, "GET /api/health": opts.health ?? 200, "GET /api/admin": 401, "POST /mcp": 401, "GET /api/webhook": 403,
    "GET /api/cron/retry-wakes": 401, "POST /api/webhook": 401, "GET /api/admin/meta-setup": 404,
    "DELETE /api/admin/conversations/c_00000000000000000000": 401,
  };
  const server = createServer((req, res) => {
    req.resume();
    n++;
    const key = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`;
    res.statusCode = n <= (opts.failFirst ?? 0) ? 503 : (expected[key] ?? 404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests: () => n, close: () => server.close() };
}
const smoke = (url: string, args: string[]) =>
  run("bash", ["scripts/smoke.sh", url, ...args], { cwd: ROOT, env: { ...process.env, SMOKE_INTERVAL: "1" } });

test("smoke: a healthy Worker passes on the first attempt", async () => {
  const w = await fakeWorker();
  try {
    const r = await smoke(w.url, ["--wait", "0"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /SMOKE PASS \(attempt 1,/);
    assert.match(r.out, /PASS GET \/api\/health \(200\)/);
  } finally { w.close(); }
});

test("smoke: a Worker that is not ready yet is retried until it passes", async () => {
  const w = await fakeWorker({ failFirst: 12 }); // more than one full attempt (9 checks)
  try {
    const r = await smoke(w.url, ["--wait", "60"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /attempt 1: \d+ check\(s\) not passing yet; retrying/);
    assert.match(r.out, /SMOKE PASS \(attempt [2-9],/);
  } finally { w.close(); }
});

test("smoke: a check that keeps failing ends in a clear FAIL and exit 1 once the wait is over; --wait 0 does not retry", async () => {
  const w = await fakeWorker({ health: 404 });
  try {
    const r = await smoke(w.url, ["--wait", "2"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL GET \/api\/health \(expected 200, got 404\)/);
    assert.match(r.out, /SMOKE FAIL after [2-9] attempt\(s\)/);
    const before = w.requests();
    const once = await smoke(w.url, ["--wait", "0"]);
    assert.equal(once.code, 1);
    assert.match(once.out, /SMOKE FAIL after 1 attempt\(s\)/);
    assert.equal(w.requests() - before, 9);
  } finally { w.close(); }
});
