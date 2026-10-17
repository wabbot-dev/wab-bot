/** Static pages. No data, no secrets are embedded; the admin page asks for the token in the browser and keeps it in sessionStorage. */

export const HEALTH_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>WAB bot</title></head><body style="font-family:system-ui,sans-serif;margin:0;padding:16px"><main>ok</main></body></html>`;

export const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Staff console</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px}main{max-width:1100px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #888;padding:4px;vertical-align:top}tr.alert{background:#ffe9e9}button{margin:1px}</style></head>
<body><main><h1>Staff console</h1>
<p><input id="tok" type="password" placeholder="Admin token" style="width:280px"> <button id="load">Load / refresh</button> <small id="msg"></small></p>
<div id="ov"></div><section id="detail" hidden><h2>Conversation (last 50 messages)</h2><pre id="pre" style="white-space:pre-wrap"></pre></section></main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var tok = $("tok"); tok.value = sessionStorage.getItem("wb_admin") || "";
  var fmt = function (iso) { return iso ? new Date(iso).toLocaleString() : "-"; };
  function el(tag, text, attrs) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; for (var k in (attrs || {})) e.setAttribute(k, attrs[k]); return e; }
  async function call(path, init) {
    init = init || {}; init.headers = Object.assign({}, init.headers, { Authorization: "Bearer " + tok.value }); init.cache = "no-store";
    var res = await fetch(path, init); var json = null; try { json = await res.json(); } catch (e) {}
    return { res: res, json: json };
  }
  // Manual refresh only: there is deliberately NO polling timer.
  async function load() {
    sessionStorage.setItem("wb_admin", tok.value);
    var r = await call("/api/admin");
    if (!r.res.ok) { $("msg").textContent = r.res.status === 401 ? "Unauthorized" : "Error " + r.res.status; return; }
    $("msg").textContent = ""; render(r.json);
  }
  async function act(action, id, value) {
    var r = await call("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: action, conversation_id: id, value: value }) });
    $("msg").textContent = r.res.ok && !(r.json && r.json.ok === false) ? action + ": ok" : action + ": " + ((r.json && r.json.error) || r.res.status);
    await load();
  }
  async function open(id) { var r = await call("/api/admin?conversation=" + encodeURIComponent(id)); $("pre").textContent = JSON.stringify(r.json, null, 2); $("detail").hidden = false; }
  function render(d) {
    var ov = $("ov"); ov.textContent = "";
    var p = el("p"); p.append("Auto-reply: "); p.append(el("b", d.controls.auto_reply)); p.append(" | Launch mode: "); p.append(el("b", d.controls.launch_mode));
    p.append(" | Rejected webhooks: "); p.append(el("b", String(d.rejections.count))); p.append(" (last " + fmt(d.rejections.last) + ") ");
    var pb = el("button", "Pause"); pb.onclick = function () { act("set_auto_reply", undefined, "paused"); }; var rb = el("button", "Resume"); rb.onclick = function () { act("set_auto_reply", undefined, "active"); };
    p.append(pb, " ", rb); ov.append(p);
    var t = el("table"); var hr = el("tr");
    ["Customer", "State", "Unhandled", "Last inbound", "24h", "Wake", "Last reply", "Reason", "Actions"].forEach(function (h) { hr.append(el("th", h)); }); t.append(hr);
    d.conversations.forEach(function (r) {
      var tr = el("tr"); if (r.state === "escalated" || r.state === "held_for_review") tr.className = "alert";
      var a = el("a", (r.name || "(no name)") + " +" + r.wa_id, { href: "#" }); a.onclick = function (e) { e.preventDefault(); open(r.id); };
      var c0 = el("td"); c0.append(a); tr.append(c0);
      [r.state, String(r.unhandled), fmt(r.last_inbound_at), r.window_open ? "open" : "closed", r.wake.status + (r.wake.failures ? " (" + r.wake.failures + " failed)" : ""), r.last_reply_status || "-", r.escalation_reason || r.hold_reason || ""].forEach(function (x) { tr.append(el("td", x)); });
      var ac = el("td");
      [["Take over", "takeover"], ["Release", "release"], ["Release hold", "release_hold"], ["Reopen", "reopen"], ["Resolve", "resolve"], ["Wake", "wake"]].forEach(function (b) {
        var bt = el("button", b[0]); bt.onclick = function () { act(b[1], r.id); }; ac.append(bt, " ");
      });
      var del = el("button", "Delete data"); del.onclick = function () { if (confirm("Erase this conversation and its messages from the bridge?")) act("delete_conversation", r.id); }; ac.append(del);
      tr.append(ac); t.append(tr);
    });
    ov.append(t);
  }
  $("load").onclick = load;
})();
</script></body></html>`;
