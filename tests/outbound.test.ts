// Rich outbound messages (docs/OUTBOUND.md): documents/images by URL or media id, reply buttons, lists, template header + buttons.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpRoute } from "../lib/mcp";
import { mediaUrlOk } from "../lib/outbound";
import { claimConversation, getHistory, sendReply, startConversation } from "../lib/tools";
import { activate, cid, getConv, inboundPayload, makeHarness, MCP_TOKEN, post } from "./helpers";

async function claimed(env: Record<string, string> = {}) {
  const h = makeHarness(env);
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.O1", text: "send me the price list" }));
  await h.flush();
  const c: any = await claimConversation(h.ctx, cid());
  await getHistory(h.ctx, cid(), c.lease);
  return { h, lease: c.lease as string };
}
const sends = (h: ReturnType<typeof makeHarness>) => h.net.graph.filter((c) => /\/messages$/.test(c.url) && c.body?.type && c.body.status === undefined);

test("a document by https URL goes out with filename and caption; history shows it", async () => {
  const { h, lease } = await claimed();
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "Here is our price list", media: { type: "document", url: "https://files.example.com/prices.pdf", filename: "prices.pdf" } });
  assert.equal(r.ok, true);
  assert.equal(r.sent_as, "document");
  const b = sends(h).at(-1)!.body;
  assert.equal(b.type, "document");
  assert.deepEqual(b.document, { link: "https://files.example.com/prices.pdf", filename: "prices.pdf", caption: "Here is our price list" });
  const m = (await getConv(h)).messages.at(-1)!;
  assert.equal(m.type, "document");
  assert.equal(m.text, "[document prices.pdf] Here is our price list");
  // image by media id, no caption needed
  const r2: any = await sendReply(h.ctx, { conversation_id: cid(), lease, media: { type: "image", id: "1234567890" } });
  assert.equal(r2.ok, true);
  assert.deepEqual(sends(h).at(-1)!.body.image, { id: "1234567890" });
});

test("media URL rules: https, no private hosts, optional OUTBOUND_MEDIA_HOSTS; bad parts refused before any Meta call", async () => {
  assert.equal(mediaUrlOk("https://cdn.example.com/a.jpg", []), true);
  for (const u of ["http://cdn.example.com/a.jpg", "https://127.0.0.1/a", "https://localhost/a", "https://u:p@example.com/a", "https://x.internal/a", "nope"]) assert.equal(mediaUrlOk(u, []), false, u);
  assert.equal(mediaUrlOk("https://files.shop.example/a.pdf", ["shop.example"]), true);
  assert.equal(mediaUrlOk("https://evil.example/a.pdf", ["shop.example"]), false);
  const { h, lease } = await claimed({ OUTBOUND_MEDIA_HOSTS: "shop.example" });
  const before = sends(h).length;
  const cases: [Record<string, unknown>, string][] = [
    [{ media: { type: "document", url: "https://evil.example/x.pdf" } }, "media_url_not_allowed"],
    [{ media: { type: "video", url: "https://shop.example/x.mp4" } }, "media_type_unsupported"],
    [{ media: { type: "image", url: "https://shop.example/x.jpg", id: "123456" } }, "media_give_url_or_id"],
    [{ text: "pick", buttons: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }] }, "buttons_one_to_three"],
    [{ text: "pick", buttons: [{ id: "a", title: "x".repeat(21) }] }, "buttons_invalid_id_or_title_max_20"],
    [{ text: " ", buttons: [{ id: "a", title: "A" }] }, "interactive_needs_text"],
    [{ text: "x", media: { type: "image", id: "123456" }, buttons: [{ id: "a", title: "A" }] }, "give_one_of_media_buttons_list"],
    [{ text: "x", template_header: { type: "text", text: "h" } }, "template_parts_need_template_name"],
  ];
  for (const [extra, err] of cases) {
    const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "x", ...extra } as any);
    assert.equal(r.error, err, JSON.stringify(extra));
  }
  assert.equal(sends(h).length, before);
});

test("reply buttons and a list become Meta interactive messages; the tapped title comes back as the customer's message", async () => {
  const { h, lease } = await claimed();
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "Delivery or pickup?", buttons: [{ id: "delivery", title: "Delivery" }, { id: "pickup", title: "Pickup" }] });
  assert.equal(r.ok, true);
  assert.equal(r.sent_as, "interactive");
  const b = sends(h).at(-1)!.body;
  assert.deepEqual(b.interactive, { type: "button", body: { text: "Delivery or pickup?" }, action: { buttons: [{ type: "reply", reply: { id: "delivery", title: "Delivery" } }, { type: "reply", reply: { id: "pickup", title: "Pickup" } }] } });
  assert.match((await getConv(h)).messages.at(-1)!.text, /\[buttons: Delivery \| Pickup\]/);
  const r2: any = await sendReply(h.ctx, {
    conversation_id: cid(), lease, text: "Choose a size",
    list: { button: "Sizes", sections: [{ rows: [{ id: "s", title: "Small" }, { id: "l", title: "Large", description: "serves 4" }] }] },
  });
  assert.equal(r2.ok, true);
  assert.deepEqual(sends(h).at(-1)!.body.interactive.action, { button: "Sizes", sections: [{ rows: [{ id: "s", title: "Small" }, { id: "l", title: "Large", description: "serves 4" }] }] });
  await post(h, inboundPayload({ wamid: "wamid.O2", tsMs: h.clock.now() + 1, type: "interactive", extra: { interactive: { type: "button_reply", button_reply: { id: "pickup", title: "Pickup" } } } }));
  await h.flush();
  assert.equal((await getConv(h)).messages.filter((m) => m.dir === "in").at(-1)!.text, "Pickup");
});

test("templates with an image header, body parameters and a dynamic URL button; start_conversation carries them too", async () => {
  const { h, lease } = await claimed({ WA_TEMPLATE_ALLOWLIST: "order_ready" });
  const r: any = await sendReply(h.ctx, {
    conversation_id: cid(), lease, template_name: "order_ready", template_params: ["A-17"],
    template_header: { type: "image", url: "https://cdn.example.com/receipt.png" }, template_buttons: [{ index: 0, sub_type: "url", param: "A-17" }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(sends(h).at(-1)!.body.template.components, [
    { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example.com/receipt.png" } }] },
    { type: "body", parameters: [{ type: "text", text: "A-17" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "A-17" }] },
  ]);
  assert.equal((await getConv(h)).messages.at(-1)!.text, "[template order_ready with image]");
  const bad: any = await sendReply(h.ctx, { conversation_id: cid(), lease, template_name: "order_ready", media: { type: "image", id: "123456" } });
  assert.equal(bad.error, "template_use_template_header_and_template_buttons");
  const s: any = await startConversation(h.ctx, { conversation_id: cid(), template_name: "order_ready", idempotency_key: "k1", template_buttons: [{ index: 1, sub_type: "quick_reply", param: "confirm" }] });
  assert.equal(s.error, "conversation_active_use_send_reply", "the guards still run first");
});

test("MCP: send_reply lists the rich parameters and passes them through", async () => {
  const { h, lease } = await claimed();
  const route = createMcpRoute(() => h.ctx);
  const rpc = (method: string, params: unknown) => route(new Request("https://x.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${MCP_TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  const list: any = await (await rpc("tools/list", {})).json();
  const sr = list.result.tools.find((t: any) => t.name === "send_reply");
  for (const k of ["media", "buttons", "list", "template_header", "template_buttons"]) assert.ok(sr.inputSchema.properties[k], k);
  const res: any = await (await rpc("tools/call", { name: "send_reply", arguments: { conversation_id: cid(), lease, text: "Our menu", media: { type: "image", url: "https://cdn.example.com/menu.jpg" } } })).json();
  assert.match(res.result.content[0].text, /"sent_as":"image"/);
});
