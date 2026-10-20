// Inbound documents (text extracted with Workers AI toMarkdown), video (noted), shared contacts and full locations (docs/MEDIA.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { contactsText, extractText, locationText } from "../lib/webhook";
import { documentText, MEDIA_METRICS_KEY, type MarkdownResult, type MediaMetrics } from "../lib/media";
import { activate, getConv, inboundPayload, makeHarness, post, type Harness } from "./helpers";

const DOC_URL = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=doc";
function docNet(h: Harness, bytes = new Uint8Array(500).fill(37)) {
  const inner = h.ctx.fetch;
  h.ctx.fetch = async (input, init) => {
    const url = String(input);
    if (/^https:\/\/graph\.facebook\.com\/v[\d.]+\/DOC/.test(url)) return Response.json({ url: DOC_URL, mime_type: "application/pdf", file_size: bytes.byteLength, id: "DOC1" });
    if (url.startsWith("https://lookaside.fbsbx.com/")) return new Response(bytes as unknown as BodyInit);
    return inner(input, init);
  };
}
function fakeMarkdown(h: Harness, out: MarkdownResult[] | Error) {
  const calls: { name: string; type: string; size: number }[] = [];
  h.ctx.ai = {
    run: async () => { throw new Error("no model should run for a document"); },
    toMarkdown: async (files) => { for (const f of files) calls.push({ name: f.name, type: f.blob.type, size: f.blob.size }); if (out instanceof Error) throw out; return out; },
  };
  return calls;
}
const docPayload = (wamid: string, mime = "application/pdf", filename = "Price list 2026.pdf", caption?: string) =>
  inboundPayload({ wamid, type: "document", extra: { document: { id: "DOC1", mime_type: mime, filename, sha256: "x", ...(caption ? { caption } : {}) } } });

test("document: text extracted in the background with toMarkdown (no model, no Neurons), capped, counted; the agent waits for it", async () => {
  const h = makeHarness();
  await activate(h);
  docNet(h);
  const calls = fakeMarkdown(h, [{ name: "document.pdf", format: "markdown", data: "# Price list\n\nItem A: 10 USD\nItem B: 12 USD" }]);
  await post(h, docPayload("wamid.D1", "application/pdf", "Price list 2026.pdf", "our prices?"));
  const before = (await getConv(h)).messages[0]!;
  assert.equal(before.text, '[document "Price list 2026.pdf", reading pending] caption: our prices?');
  assert.equal(h.net.wakes.length, 0, "wake waits for the text");
  await h.flush();
  assert.deepEqual(calls, [{ name: "document.pdf", type: "application/pdf", size: 500 }]);
  const m = (await getConv(h)).messages[0]!;
  assert.equal(m.type, "document");
  assert.equal(m.text, '[document "Price list 2026.pdf", text extracted] caption: our prices? | # Price list\n\nItem A: 10 USD\nItem B: 12 USD');
  assert.deepEqual(m.media, { kind: "document", st: "done" });
  assert.equal(h.net.wakes.length, 1);
  const mm = (await h.store.get<MediaMetrics>(MEDIA_METRICS_KEY))?.value;
  assert.equal(mm?.today.documents_read, 1);
});

test("document: unsupported type, conversion error, off switch and no toMarkdown give a plain marker; never a model call", async () => {
  const a = makeHarness(); await activate(a); docNet(a);
  const ca = fakeMarkdown(a, [{ format: "markdown", data: "x" }]);
  await post(a, docPayload("wamid.D2", "application/zip", "stuff.zip"));
  await a.flush();
  assert.equal(ca.length, 0);
  assert.equal((await getConv(a)).messages[0]!.text, '[document "stuff.zip", not read: this file type is not read]');
  const b = makeHarness(); await activate(b); docNet(b);
  fakeMarkdown(b, [{ format: "error", error: "bad pdf" }]);
  await post(b, docPayload("wamid.D3"));
  await b.flush();
  assert.equal((await getConv(b)).messages[0]!.text, '[document "Price list 2026.pdf", not read: could not read the file]');
  const c = makeHarness({ MEDIA_READ_DOCUMENTS: "off" }); await activate(c);
  await post(c, docPayload("wamid.D4", "application/pdf", "../../etc/passwd"));
  assert.equal((await getConv(c)).messages[0]!.text, '[document "passwd", not read]', "file name shown without its path");
  const d = makeHarness(); await activate(d); docNet(d);
  d.ctx.ai = { run: async () => ({}) };
  await post(d, docPayload("wamid.D5"));
  await d.flush();
  assert.match((await getConv(d)).messages[0]!.text, /not read/);
});

test("documentText drops the PDF metadata header Workers AI adds (seen live), keeps the contents", () => {
  const live = "# document.pdf\n## Metadata\n- PDFFormatVersion=1.4\n- IsLinearized=false\n- IsSignaturesPresent=false\n\n## Contents\n### Page 1\nOpening hours 9 to 5\nBulk price 12 USD per box\n";
  assert.equal(documentText({ filename: "hours.pdf" }, live, 3000), '[document "hours.pdf", text extracted] Opening hours 9 to 5\nBulk price 12 USD per box');
  assert.equal(documentText({}, "# Price list\n\nItem A", 3000), "[document, text extracted] # Price list\n\nItem A", "a normal heading stays");
});

test("documentText caps long text; empty text says it may be a scan", () => {
  assert.equal(documentText({ filename: "a.pdf" }, "x".repeat(50), 10), '[document "a.pdf", text extracted, first 10 characters] xxxxxxxxxx');
  assert.equal(documentText({}, "   ", 10), "[document, read: no text found (a scan or photo?)]");
});

test("video is noted (not watched); shared contacts and full locations are readable text; sticker", () => {
  assert.equal(extractText({ type: "video", video: { caption: "the leak" } }), "[video, not watched: ask the customer to describe it if it matters] caption: the leak");
  assert.equal(extractText({ type: "sticker", sticker: {} }), "[sticker]");
  assert.equal(locationText({ latitude: 33.8938, longitude: 35.5018, name: "Main office", address: "1 Example St" }),
    "[location: 33.8938, 35.5018; name: Main office; address: 1 Example St; map: https://maps.google.com/?q=33.8938,35.5018]");
  assert.equal(locationText({ latitude: 999, longitude: 1 }), "[location]", "nonsense coordinates are dropped");
  assert.equal(extractText({ type: "location", location: { latitude: "1.5", longitude: "2" } }), "[location: 1.5, 2; map: https://maps.google.com/?q=1.5,2]");
  assert.equal(contactsText([{ name: { formatted_name: "Sam Example" }, org: { company: "Acme" }, phones: [{ phone: "+1 555 0100", wa_id: "15550100" }], emails: [{ email: "sam@example.test" }] }]),
    "[shared contact: Sam Example (Acme); phone: +1 555 0100 (WhatsApp 15550100); email: sam@example.test]");
  assert.equal(contactsText([{ name: { first_name: "A[x]" } }]), "[shared contact: A x]");
  assert.equal(extractText({ type: "contacts" }), "[shared contact without details]");
});

test("location, contacts and video end to end: stored as text, wake as usual", async () => {
  const h = makeHarness();
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.L1", type: "location", extra: { location: { latitude: 10.5, longitude: -20.25, name: "Gate 3" } } }));
  await post(h, inboundPayload({ wamid: "wamid.C1", type: "contacts", extra: { contacts: [{ name: { formatted_name: "Pat" }, phones: [{ phone: "+1 555 0101" }] }] } }));
  await post(h, inboundPayload({ wamid: "wamid.VD1", type: "video", extra: { video: { id: "V", mime_type: "video/mp4" } } }));
  const msgs = (await getConv(h)).messages.map((m) => m.text);
  assert.deepEqual(msgs, ["[location: 10.5, -20.25; name: Gate 3; map: https://maps.google.com/?q=10.5,-20.25]", "[shared contact: Pat; phone: +1 555 0101]", "[video, not watched: ask the customer to describe it if it matters]"]);
});

test("owner media self-test reads a document too (kind=document, filename), with no Meta call and no wake", async () => {
  const { adminMediaSelftest } = await import("../lib/admin");
  const { ADMIN_TOKEN } = await import("./helpers");
  const h = makeHarness({ MEDIA_SELFTEST: "1" });
  await activate(h);
  fakeMarkdown(h, [{ name: "document.pdf", format: "markdown", data: "Opening hours: 9 to 5" }]);
  const req = new Request("https://x.test/api/admin/media-selftest?kind=document&filename=hours.pdf", { method: "POST", headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/pdf" }, body: new Uint8Array(300).fill(37) });
  const j: any = await (await adminMediaSelftest(h.ctx, req)).json();
  assert.equal(j.ok, true);
  assert.equal(j.media_status, "done");
  assert.equal(h.net.graph.length, 0);
  assert.equal(h.net.wakes.length, 0);
});
