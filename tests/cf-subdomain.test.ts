// workers.dev subdomain registration (scripts/cf-subdomain.mjs), run against a mocked Cloudflare client and a fake `fetch`: no network.
// Also checks that cf-api-deploy.mjs embeds the function into the program it runs, with a fake global fetch in a child process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSubdomain, type CfClient, type CfResponse } from "../scripts/cf-subdomain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Call = { method: string; path: string; body?: any };
const ok = (subdomain?: string): CfResponse => ({ success: true, status: 200, result: subdomain ? { subdomain } : {}, errors: [] });
const err = (status: number, code: number, message: string): CfResponse => ({ success: false, status, errors: [{ code, message }] });

/** A fake account: `state.sub` is the registered subdomain (or null); `taken` are names PUT must refuse. */
function fakeAccount(state: { sub: string | null; taken?: string[]; getNone?: () => CfResponse; putError?: CfResponse; getError?: CfResponse }) {
  const calls: Call[] = [];
  const client: CfClient = {
    async request(req) {
      calls.push({ method: req.method, path: req.path, body: req.body });
      assert.equal(req.path, "/accounts/acc123/workers/subdomain");
      if (req.method === "GET") return state.getError ?? (state.sub ? ok(state.sub) : state.getNone ? state.getNone() : ok());
      assert.equal(req.method, "PUT");
      if (state.putError) return state.putError;
      const name = req.body.subdomain as string;
      if (state.taken?.includes(name)) return err(409, 10000, "That subdomain is already taken");
      state.sub = name;
      return ok(name);
    },
  };
  return { client, calls, puts: () => calls.filter((c) => c.method === "PUT") };
}
const seq = (...v: string[]) => { let i = 0; return () => v[i++] ?? "ffffff"; };

test("subdomain: an existing one is returned and never changed (no PUT)", async () => {
  const a = fakeAccount({ sub: "mine" });
  const r = await ensureSubdomain(a.client, "acc123", { workerName: "wab-bot", subdomain: "other" });
  assert.deepEqual(r, { ok: true, created: false, subdomain: "mine" });
  assert.deepEqual(a.calls.map((c) => c.method), ["GET"]);
});

test("subdomain: none registered -> PUT '<worker>-<suffix>', read back, used", async () => {
  const a = fakeAccount({ sub: null });
  const r = await ensureSubdomain(a.client, "acc123", { workerName: "wab-bot", random: seq("a1b2c3") });
  assert.deepEqual(r, { ok: true, created: true, subdomain: "wab-bot-a1b2c3" });
  assert.deepEqual(a.calls.map((c) => c.method), ["GET", "PUT", "GET"]);
  assert.deepEqual(a.puts()[0].body, { subdomain: "wab-bot-a1b2c3" });
});

test("subdomain: a 404 or error 10007 on GET also means 'none yet'", async () => {
  for (const none of [() => err(404, 10007, "no subdomain"), () => err(404, 1000, "not found"), () => err(400, 10007, "workers.api.error.no_subdomain")]) {
    const a = fakeAccount({ sub: null, getNone: none });
    const r = await ensureSubdomain(a.client, "acc123", { workerName: "w1", random: seq("000001") });
    assert.equal(r.ok && r.created, true);
  }
});

test("subdomain: --subdomain NAME is used as given, once", async () => {
  const a = fakeAccount({ sub: null });
  const r = await ensureSubdomain(a.client, "acc123", { workerName: "wab-bot", subdomain: "acme-wa" });
  assert.deepEqual(r, { ok: true, created: true, subdomain: "acme-wa" });
  assert.deepEqual(a.puts().map((c) => c.body.subdomain), ["acme-wa"]);
  const b = fakeAccount({ sub: null, taken: ["acme-wa"] });
  const t = await ensureSubdomain(b.client, "acc123", { workerName: "wab-bot", subdomain: "acme-wa" });
  assert.equal(t.ok, false);
  assert.match(t.ok ? "" : t.error, /taken \(acme-wa;.*Pass a different --subdomain NAME/);
  assert.equal(b.puts().length, 1);
  const bad = await ensureSubdomain(fakeAccount({ sub: null }).client, "acc123", { subdomain: "Bad_Name" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /not valid/);
});

test("subdomain: a taken name is retried with a new suffix, then succeeds", async () => {
  const a = fakeAccount({ sub: null, taken: ["wab-bot-000001", "wab-bot-000002"] });
  const r = await ensureSubdomain(a.client, "acc123", { workerName: "wab-bot", random: seq("000001", "000002", "000003", "000004", "000005") });
  assert.deepEqual(r, { ok: true, created: true, subdomain: "wab-bot-000003" });
  assert.deepEqual(a.puts().map((c) => c.body.subdomain), ["wab-bot-000001", "wab-bot-000002", "wab-bot-000003"]);
});

test("subdomain: every attempt taken -> a readable failure naming the tries, nothing registered", async () => {
  const names = ["000001", "000002", "000003"].map((s) => "w-" + s);
  const a = fakeAccount({ sub: null, taken: names });
  const r = await ensureSubdomain(a.client, "acc123", { workerName: "w", attempts: 3, random: seq("000001", "000002", "000003") });
  assert.equal(r.ok, false);
  const msg = r.ok ? "" : r.error;
  assert.match(msg, /every workers\.dev subdomain tried was taken \(w-000001, w-000002, w-000003; last answer: 10000: That subdomain is already taken\)/);
  assert.match(msg, /pass --subdomain NAME/);
  assert.equal(a.puts().length, 3);
  assert.equal(a.client && (await a.client.request({ method: "GET", path: "/accounts/acc123/workers/subdomain" })).result.subdomain, undefined);
});

test("subdomain: a rejection that is not 'taken' (no permission) stops at once with a hint", async () => {
  const a = fakeAccount({ sub: null, putError: err(403, 10000, "Authentication error") });
  const r = await ensureSubdomain(a.client, "acc123", { workerName: "wab-bot", random: seq("000001") });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /rejected registering .*10000: Authentication error.*Workers Scripts: Edit/);
  assert.equal(a.puts().length, 1);
});

test("subdomain: an unreadable GET (bad token, outage) is not guessed at: no PUT", async () => {
  for (const e of [err(403, 10000, "Authentication error"), err(500, 0, "boom"), err(401, 9109, "Invalid token")]) {
    const a = fakeAccount({ sub: null, getError: e });
    const r = await ensureSubdomain(a.client, "acc123", { workerName: "wab-bot" });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /could not read the account's workers\.dev subdomain/);
    assert.equal(a.puts().length, 0);
  }
});

test("subdomain: a PUT that succeeds but cannot be read back fails clearly", async () => {
  let n = 0;
  const client: CfClient = { async request(req) { n++; if (req.method === "PUT") return ok("x-000001"); return n === 1 ? ok() : err(500, 0, "boom"); } };
  const r = await ensureSubdomain(client, "acc123", { workerName: "x", random: seq("000001") });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /could not read the subdomain back/);
});

test("subdomain: a long Worker name still yields a valid name (<= 63 chars, no trailing dash)", async () => {
  const a = fakeAccount({ sub: null });
  const worker = "a".repeat(55) + "-bcd";
  const r = await ensureSubdomain(a.client, "acc123", { workerName: worker, random: seq("abcdef") });
  assert.equal(r.ok, true);
  const used = a.puts()[0].body.subdomain as string;
  assert.ok(used.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(used), used);
});

// ---- cf-api-deploy.mjs end to end against a fake global fetch (child process, preloaded; no network) ----
function runCli(args: string[], accountSub: string | null) {
  const preload = `
    const calls = []; let sub = ${JSON.stringify(accountSub)};
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname.replace("/client/v4", ""); const method = init.method || "GET";
      calls.push(method + " " + path);
      const reply = (status, j) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
      if (path.endsWith("/workers/subdomain")) {
        if (method === "PUT") { sub = JSON.parse(init.body).subdomain; return reply(200, { success: true, result: { subdomain: sub } }); }
        return sub ? reply(200, { success: true, result: { subdomain: sub } }) : reply(404, { success: false, errors: [{ code: 10007, message: "none" }] });
      }
      if (path.endsWith("/workers/scripts")) return reply(200, { success: true, result: [{ id: "other-worker" }] });
      if (/\\/workers\\/scripts\\/[^/]+$/.test(path) && method === "PUT") return reply(200, { success: true, result: {} });
      if (path.endsWith("/subdomain")) return reply(200, { success: true, result: { enabled: true } });
      return reply(200, { success: true, result: {} });
    };
    process.on("exit", () => console.error("CALLS " + calls.join(" | ")));`;
  return new Promise<{ code: number; out: string; err: string }>((res) => {
    const c = execFile(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload), "scripts/cf-api-deploy.mjs", ...args],
      { cwd: ROOT, env: { ...process.env, CLOUDFLARE_API_TOKEN: "fake-token-for-test", CLOUDFLARE_ACCOUNT_ID: "acc123" }, timeout: 60_000 },
      (e, out, er) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err: er }));
    c.stdin?.end();
  });
}

test("cli subdomain: registers when none, leaves an existing one alone, and prints no token", async () => {
  const a = await runCli(["subdomain", "--name", "wab-bot", "--subdomain", "acme-wa"], null);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /registered the account's workers\.dev subdomain: acme-wa/);
  assert.match(a.err, /GET \/accounts\/acc123\/workers\/subdomain \| PUT \/accounts\/acc123\/workers\/subdomain \| GET/);
  const b = await runCli(["subdomain", "--name", "wab-bot", "--subdomain", "acme-wa"], "already-here");
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /already registered \(unchanged\): already-here/);
  assert.doesNotMatch(b.err, /PUT/);
  assert.ok(!(a.out + a.err + b.out + b.err).includes("fake-token-for-test"));
  const bad = await runCli(["subdomain", "--name", "wab-bot", "--subdomain", "Bad_Name"], null);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--subdomain must be/);
});

test("cli deploy: the embedded program registers the subdomain BEFORE the upload and builds the URL from it", async () => {
  const a = await runCli(["deploy", "--name", "wab-bot", "--subdomain", "acme-wa", "--no-nonce", "--self-provision", "--secrets-file", "/dev/null", "--bundle", "package.json"], null);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /"url": "https:\/\/wab-bot\.acme-wa\.workers\.dev"/);
  assert.match(a.out, /"created": true/);
  const calls = a.err.split("CALLS ")[1];
  assert.ok(calls.indexOf("PUT /accounts/acc123/workers/subdomain") < calls.indexOf("PUT /accounts/acc123/workers/scripts/wab-bot"), calls);
});

test("cli deploy: refuses to upload over an existing Worker of the same name (maybe another bot) unless --update; check-name exit codes", async () => {
  const base = ["--subdomain", "acme-wa", "--no-nonce", "--self-provision", "--secrets-file", "/dev/null", "--bundle", "package.json"];
  const a = await runCli(["deploy", "--name", "other-worker", ...base], "acme-wa");
  assert.equal(a.code, 1);
  assert.match(a.err, /already exists in this account \(maybe another bot\)/);
  assert.doesNotMatch(a.err.split("CALLS ")[1] ?? "", /PUT \/accounts\/acc123\/workers\/scripts\/other-worker/, "nothing uploaded");
  const b = await runCli(["deploy", "--name", "other-worker", "--update", ...base], "acme-wa");
  assert.equal(b.code, 0, b.err);
  assert.equal((await runCli(["check-name", "--name", "other-worker"], "acme-wa")).code, 3);
  assert.equal((await runCli(["check-name", "--name", "wab-bot-new"], "acme-wa")).code, 0);
});
