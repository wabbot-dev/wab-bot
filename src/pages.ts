/** Static pages. No data, no secrets are embedded. The team inbox signs staff in with a one-time code (session cookie); owners may type the admin token, which stays in sessionStorage of that tab. */

export const HEALTH_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>WAB bot</title></head><body style="font-family:system-ui,sans-serif;margin:0;padding:16px"><main>ok</main></body></html>`;

export const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Team inbox</title>
<style>
:root{--bg:#f4f5f7;--pane:#fff;--line:#e3e5e8;--mut:#667;--acc:#0b7a5a;--in:#fff;--out:#d9f7e8;--warn:#b42318;--chip:#eef}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:#111;height:100vh;display:flex;flex-direction:column}
header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;background:var(--pane);border-bottom:1px solid var(--line)}
header h1{font-size:17px;margin:0 8px 0 0}.sp{flex:1}.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:var(--chip)}.pill.bad{background:#fde7e7;color:var(--warn)}.pill.ok{background:#dcf5e9;color:var(--acc)}
button{font:inherit;border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 10px;cursor:pointer}button.pri{background:var(--acc);color:#fff;border-color:var(--acc)}button.dan{color:var(--warn)}button:disabled{opacity:.5;cursor:default}
input,textarea,select{font:inherit;border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:#fff}
#app{flex:1;display:flex;min-height:0}#list{width:360px;max-width:100%;background:var(--pane);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
#tools{padding:8px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px}#tabs{display:flex;gap:4px;flex-wrap:wrap}#tabs button{font-size:13px;padding:3px 8px}#tabs button.on{background:#111;color:#fff;border-color:#111}
#items{overflow:auto;flex:1}.it{padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:2px 8px}.it:hover,.it.sel{background:#f0f7f4}.it .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.it .tm{font-size:12px;color:var(--mut)}.it .pv{font-size:13px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{background:var(--acc);color:#fff;border-radius:99px;font-size:12px;min-width:20px;text-align:center;padding:0 6px;justify-self:end}.it.need .nm::before{content:"\\25CF ";color:var(--warn)}
#thread{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}#th{padding:8px 12px;background:var(--pane);border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:6px;align-items:center}#th .who{font-weight:600;margin-right:6px}
#acts{display:flex;gap:4px;flex-wrap:wrap}#msgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:6px}
.b{max-width:76%;padding:7px 10px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px 1px #0001}.b.in{background:var(--in);align-self:flex-start;border-top-left-radius:3px}.b.out{background:var(--out);align-self:flex-end;border-top-right-radius:3px}.b small{display:block;font-size:11px;color:var(--mut);margin-top:3px}
#compose{display:flex;gap:6px;padding:8px;background:var(--pane);border-top:1px solid var(--line);align-items:flex-end}#compose textarea{flex:1;resize:vertical;min-height:42px;max-height:180px}#note{font-size:12px;color:var(--mut);padding:0 10px 6px;background:var(--pane)}
#empty{margin:auto;color:var(--mut)}#login{margin:40px auto;max-width:380px;background:var(--pane);padding:20px;border-radius:12px;border:1px solid var(--line);display:flex;flex-direction:column;gap:10px}
#toast{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:6px 12px;border-radius:8px;font-size:13px;display:none}
.back{display:none}@media (max-width:760px){#list{width:100%}#app.open #list{display:none}#app:not(.open) #thread{display:none}.back{display:inline-block}.b{max-width:88%}}
</style></head>
<body>
<header><h1>Team inbox</h1><span id="ar" class="pill">auto-reply ?</span><span id="lm" class="pill">mode ?</span><button id="pause" hidden>Pause bot</button><button id="resume" hidden>Resume bot</button><span class="sp"></span><label style="font-size:13px"><input type="checkbox" id="live" checked> Live</label><button id="refresh" hidden>Refresh</button><button id="out" hidden>Sign out</button></header>
<section id="login" hidden><b>Sign in</b><span style="font-size:13px;color:var(--mut)">Enter the one-time staff code you were given. It works once and expires quickly.</span><input id="code" placeholder="XXXX-XXXX-XXXX" autocomplete="one-time-code"><button class="pri" id="go">Sign in</button><small id="lerr" style="color:var(--warn)"></small>
<details><summary style="font-size:13px">Owner sign-in</summary><p style="font-size:13px;color:var(--mut)">Owners can use the admin token. Type it here yourself; never paste it into a chat. It stays in this tab only.</p><input id="tok" type="password" placeholder="Admin token" autocomplete="off"><button id="tgo">Use token</button></details></section>
<div id="app" hidden><aside id="list"><div id="tools"><input id="q" type="search" placeholder="Search name, number or text"><div id="tabs"></div></div><div id="items"></div></aside>
<main id="thread"><div id="empty">Select a conversation</div></main></div><div id="toast"></div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var owner = sessionStorage.getItem("wb_admin") || "", data = null, sel = null, tab = "all", timer = null, busy = false;
  var TABS = [["all", "All"], ["need", "Needs a human"], ["pending", "Waiting for bot"], ["human_takeover", "Taken over"], ["opted", "Opted out"]];
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = text; if (cls) e.className = cls; return e; }
  function toast(t) { var x = $("toast"); x.textContent = t; x.style.display = "block"; clearTimeout(x._t); x._t = setTimeout(function () { x.style.display = "none"; }, 2600); }
  function ago(iso) { if (!iso) return ""; var s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return new Date(iso).toLocaleDateString(); }
  async function call(path, body) {
    var h = { "Content-Type": "application/json" };
    if (owner) h.Authorization = "Bearer " + owner; else h["X-Staff-Request"] = "1";
    var res = await fetch(path, { method: body ? "POST" : "GET", headers: h, body: body ? JSON.stringify(body) : undefined, cache: "no-store", credentials: "same-origin" });
    var j = null; try { j = await res.json(); } catch (e) {}
    return { res: res, json: j };
  }
  function showLogin(msg) { $("app").hidden = true; $("login").hidden = false; $("lerr").textContent = msg || ""; ["pause", "resume", "refresh", "out"].forEach(function (k) { $(k).hidden = true; }); stop(); }
  function showApp() { $("login").hidden = true; $("app").hidden = false; $("refresh").hidden = false; $("out").hidden = false; }
  $("go").onclick = async function () {
    var r = await fetch("/api/staff/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: $("code").value }), credentials: "same-origin" });
    $("code").value = ""; if (!r.ok) { $("lerr").textContent = "That code is wrong, used or expired. Ask for a new one."; return; }
    owner = ""; sessionStorage.removeItem("wb_admin"); start();
  };
  $("tgo").onclick = function () { owner = $("tok").value.trim(); $("tok").value = ""; if (owner) sessionStorage.setItem("wb_admin", owner); start(); };
  $("out").onclick = async function () { await fetch("/api/staff/logout", { method: "POST", credentials: "same-origin" }); owner = ""; sessionStorage.removeItem("wb_admin"); showLogin(); };
  $("refresh").onclick = function () { load(true); };
  $("pause").onclick = function () { act("set_auto_reply", null, { value: "paused" }); };
  $("resume").onclick = function () { act("set_auto_reply", null, { value: "active" }); };
  $("q").oninput = renderList;
  $("live").onchange = function () { $("live").checked ? poll() : stop(); };
  document.addEventListener("visibilitychange", function () { if (!document.hidden && $("live").checked) load(); });
  TABS.forEach(function (t) { var b = el("button", t[1]); b.onclick = function () { tab = t[0]; renderList(); }; b.dataset.k = t[0]; $("tabs").append(b); });
  function stop() { clearInterval(timer); timer = null; }
  function poll() { stop(); timer = setInterval(function () { if (!document.hidden) load(); }, 10000); }
  async function start() { var ok = await load(true); if (ok) { showApp(); if ($("live").checked) poll(); } }
  async function load(force) {
    if (busy && !force) return false; busy = true;
    try {
      var r = await call("/api/admin");
      if (r.res.status === 401) { showLogin(owner ? "That token was not accepted." : ""); owner = ""; sessionStorage.removeItem("wb_admin"); return false; }
      if (!r.res.ok) { toast("Error " + r.res.status); return false; }
      data = r.json; renderTop(); renderList(); if (sel) await openConv(sel, true); return true;
    } finally { busy = false; }
  }
  function renderTop() {
    var c = data.controls; $("ar").textContent = "bot " + c.auto_reply; $("ar").className = "pill " + (c.auto_reply === "active" ? "ok" : "bad");
    $("lm").textContent = c.launch_mode === "live" ? "live" : "test mode"; $("pause").hidden = c.auto_reply !== "active"; $("resume").hidden = c.auto_reply === "active";
  }
  function match(r) {
    if (tab === "need" && !r.needs_human) return false;
    if (tab === "pending" && r.state !== "pending" && r.state !== "claimed") return false;
    if (tab === "human_takeover" && r.state !== "human_takeover") return false;
    if (tab === "opted" && !r.opted_out) return false;
    var q = $("q").value.trim().toLowerCase(); if (!q) return true;
    return [(r.name || ""), r.wa_id, (r.last_message && r.last_message.preview) || ""].join(" ").toLowerCase().indexOf(q) >= 0;
  }
  function stateLabel(s) { return { pending: "waiting for bot", claimed: "bot is answering", replied: "answered", escalated: "needs a human", human_takeover: "taken over", held_for_review: "held for review" }[s] || s; }
  function renderList() {
    if (!data) return;
    Array.prototype.forEach.call($("tabs").children, function (b) {
      var n = data.conversations.filter(function (r) { var t = tab; tab = b.dataset.k; var m = match(r); tab = t; return m; }).length;
      b.className = b.dataset.k === tab ? "on" : ""; b.textContent = TABS.filter(function (t) { return t[0] === b.dataset.k; })[0][1] + (n ? " (" + n + ")" : "");
    });
    var box = $("items"); box.textContent = "";
    var rows = data.conversations.filter(match);
    rows.sort(function (a, b) { return (b.needs_human ? 1 : 0) - (a.needs_human ? 1 : 0) || String((b.last_message && b.last_message.at) || b.updated_at).localeCompare(String((a.last_message && a.last_message.at) || a.updated_at)); });
    if (!rows.length) box.append(el("p", "No conversations here.", "pv"));
    rows.forEach(function (r) {
      var it = el("div", null, "it" + (r.id === sel ? " sel" : "") + (r.needs_human ? " need" : ""));
      it.append(el("div", (r.name || "+" + r.wa_id), "nm"), el("div", ago((r.last_message && r.last_message.at) || r.updated_at), "tm"));
      var pv = (r.last_message ? (r.last_message.from === "business" ? "You: " : "") + r.last_message.preview : "") || stateLabel(r.state);
      it.append(el("div", pv, "pv"));
      if (r.unhandled > 0) it.append(el("div", String(r.unhandled), "badge")); else it.append(el("div", r.opted_out ? "opted out" : "", "tm"));
      it.onclick = function () { sel = r.id; renderList(); openConv(r.id); };
      box.append(it);
    });
  }
  async function act(action, id, extra) {
    var body = Object.assign({ action: action }, id ? { conversation_id: id } : {}, extra || {});
    var r = await call("/api/admin", body);
    var ok = r.res.ok && !(r.json && r.json.ok === false);
    toast(ok ? "Done" : "Not done: " + ((r.json && r.json.error) || r.res.status));
    await load(true); return ok;
  }
  async function openConv(id, quiet) {
    var r = await call("/api/admin?conversation=" + encodeURIComponent(id));
    if (!r.res.ok) { if (!quiet) toast("Could not open (" + r.res.status + ")"); return; }
    var c = r.json, t = $("thread"), keep = $("msgs"), atBottom = !keep || keep.scrollHeight - keep.scrollTop - keep.clientHeight < 40, draft = $("txt") ? $("txt").value : "";
    $("app").className = "open"; t.textContent = "";
    var th = el("div"); th.id = "th";
    var back = el("button", "\\u2190", "back"); back.onclick = function () { sel = null; $("app").className = ""; renderList(); }; th.append(back);
    th.append(el("span", c.name || "(no name)", "who"), el("span", "+" + c.wa_id, "pill"), el("span", stateLabel(c.state), "pill" + (c.state === "escalated" || c.state === "held_for_review" ? " bad" : "")));
    th.append(el("span", c.window_open ? "24h window open" : "24h window closed", "pill" + (c.window_open ? " ok" : "")));
    if (c.opted_out) th.append(el("span", "opted out", "pill bad"));
    var acts = el("div"); acts.id = "acts";
    function B(label, action, show, cls, confirmText) { if (!show) return; var b = el("button", label, cls); b.onclick = function () { if (confirmText && !confirm(confirmText)) return; act(action, c.id); }; acts.append(b); }
    var s = c.state;
    B("Take over", "takeover", s !== "human_takeover");
    B("Release to bot", "release", s === "human_takeover" || s === "escalated", "pri");
    B("Resolve", "resolve", s !== "replied");
    B("Release hold", "release_hold", s === "held_for_review");
    B("Back to bot queue", "reopen", s === "escalated" || s === "human_takeover");
    B("Wake bot", "wake", s === "pending");
    B(c.opted_out ? "Clear opt-out" : "Mark opted out", c.opted_out ? "opt_in" : "opt_out", true);
    B("Delete data", "delete_conversation", true, "dan", "Erase this conversation and its messages from the bridge?");
    th.append(acts); t.append(th);
    var msgs = el("div"); msgs.id = "msgs";
    (c.messages || []).forEach(function (m) {
      var b = el("div", m.text, "b " + (m.dir === "in" ? "in" : "out"));
      b.append(el("small", new Date(m.ts).toLocaleString() + (m.dir === "out" && m.status ? " \\u00b7 " + m.status : "")));
      msgs.append(b);
    });
    if (!(c.messages || []).length) msgs.append(el("div", "No messages yet.", "pv"));
    t.append(msgs);
    var note = el("div"); note.id = "note";
    var comp = el("div"); comp.id = "compose";
    var tx = el("textarea"); tx.id = "txt"; tx.placeholder = c.window_open ? "Type a reply (you take over the chat)" : "24h window closed: only an approved template can be sent"; tx.value = draft; tx.disabled = !c.window_open;
    var tpl = el("select"); tpl.append(el("option", "Template\\u2026")); (data.controls.template_allowlist || []).forEach(function (n) { var o = el("option", n); o.value = n; tpl.append(o); });
    var send = el("button", "Send", "pri");
    send.onclick = async function () {
      var body = { idempotency_key: "inbox-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) };
      if (tpl.selectedIndex > 0) body.template_name = tpl.value; else { if (!tx.value.trim()) return; body.text = tx.value; }
      send.disabled = true; var ok = await act("reply", c.id, body); send.disabled = false; if (ok && $("txt")) $("txt").value = "";
    };
    tx.onkeydown = function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send.onclick(); };
    comp.append(tx); if ((data.controls.template_allowlist || []).length) comp.append(tpl); comp.append(send);
    note.textContent = (data.controls.launch_mode !== "live" ? "Test mode: only test recipients get messages. " : "") + "Sending takes the chat over from the bot; use Release to bot to hand it back.";
    t.append(comp, note);
    if (atBottom || !quiet) msgs.scrollTop = msgs.scrollHeight;
  }
  fetch("/api/staff/session", { credentials: "same-origin", headers: owner ? { Authorization: "Bearer " + owner } : {} }).then(function (r) { r.ok ? start() : showLogin(); }, function () { showLogin(); });
})();
</script></body></html>`;
