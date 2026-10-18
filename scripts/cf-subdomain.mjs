// Make sure the Cloudflare account has a workers.dev subdomain before the first deploy (a brand-new account has none, and
// the Worker then has no workers.dev URL). Used by cf-api-deploy.mjs (embedded into the program it runs or emits) and unit tested
// with a mocked `cloudflare.request`; no network here.
//
// ensureSubdomain is deliberately ONE self-contained function (no imports, no outer variables): cf-api-deploy.mjs embeds its
// source text into the program it hands to a tool that already holds a Cloudflare session (--emit-plugin-js).
//
// Rules: GET /accounts/{id}/workers/subdomain first. An existing subdomain is NEVER changed (no PUT is sent). Only when none is
// registered is one created with PUT: the given name (opts.subdomain, tried once) or "<worker name>-<6 random hex>", retried with
// a new suffix a few times when the name is taken. The result is read back with a second GET and that value is returned.
export async function ensureSubdomain(cloudflare, accountId, opts) {
  const base = "/accounts/" + accountId + "/workers/subdomain";
  const o = opts || {};
  const attempts = o.attempts || 5;
  const random = o.random || (() => Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, "0"));
  const valid = (s) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s);
  const text = (r) => ((r && r.errors) || []).map((e) => (e.code ? e.code + ": " : "") + e.message).join("; ") || "HTTP " + ((r && r.status) || "?");
  const fail = (error) => ({ ok: false, error });
  const hint = (r) => (r.status === 401 || r.status === 403 ? " The API token needs the permission Workers Scripts: Edit on this account (see docs/CLOUDFLARE.md)." : "");

  const cur = await cloudflare.request({ method: "GET", path: base });
  const have = cur.success && cur.result && cur.result.subdomain;
  if (have) return { ok: true, created: false, subdomain: have };
  // "No subdomain yet" is a successful empty answer, a 404 or error code 10007; anything else (bad token, outage) is not guessed at.
  const none = cur.success || cur.status === 404 || (cur.errors || []).some((e) => e.code === 10007);
  if (!none) return fail("could not read the account's workers.dev subdomain (" + text(cur) + ")." + hint(cur) + " Nothing was registered.");

  let names;
  if (o.subdomain) {
    if (!valid(o.subdomain)) return fail("the requested subdomain '" + o.subdomain + "' is not valid: use 1-63 lowercase letters, digits and dashes, not starting or ending with a dash.");
    names = [o.subdomain];
  } else {
    const stem = String(o.workerName || "worker").slice(0, 56).replace(/-+$/, "");
    names = [];
    for (let i = 0; i < attempts; i++) {
      const n = stem + "-" + random();
      if (!names.includes(n)) names.push(n); // a repeated suffix would only repeat a refused name
    }
    if (!names.every(valid)) return fail("cannot derive a valid subdomain from the Worker name '" + o.workerName + "'; pass --subdomain NAME.");
  }

  const tried = [];
  let last = null;
  for (const name of names) {
    tried.push(name);
    const put = await cloudflare.request({ method: "PUT", path: base, body: { subdomain: name } });
    if (put.success) {
      const back = await cloudflare.request({ method: "GET", path: base });
      const got = back.success && back.result && back.result.subdomain;
      if (!got) return fail("registered '" + name + "' but could not read the subdomain back (" + text(back) + "). Check Workers & Pages, Subdomain, in the Cloudflare dashboard.");
      return { ok: true, created: true, subdomain: got };
    }
    last = put;
    const taken = put.status === 409 || /taken|already|in use|exists|unavailable|not available/i.test(text(put));
    if (!taken) return fail("Cloudflare rejected registering the workers.dev subdomain '" + name + "' (" + text(put) + ")." + hint(put) + " Nothing was changed.");
  }
  return fail("every workers.dev subdomain tried was taken (" + tried.join(", ") + "; last answer: " + text(last) + "). " + (o.subdomain ? "Pass a different --subdomain NAME." : "Run again (new random suffixes) or pass --subdomain NAME."));
}
