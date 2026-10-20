// Optional voice-note replies (docs/VOICE-REPLIES.md): mode switch, language choice, the real WebAssembly encoder, and send_reply
// with every guard kept and a text fallback on any failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadConfig } from "../lib/config";
import { MEDIA_METRICS_KEY, oggOpusSeconds, type MediaMetrics } from "../lib/media";
import { getOverview } from "../lib/overview";
import { sendReply } from "../lib/tools";
import type { Conv } from "../lib/types";
import { encodeVoiceNote, muxOggOpus, VoiceEncodeError } from "../lib/voice-encode";
import { chooseVoice, isMonoOggOpus, scriptLanguage, speak, speakable, ttsLanguages, voiceLanguage, type SpeakArgs, type SpeakResult } from "../lib/voice-reply";
import { adminVoiceSelftest } from "../lib/admin";
import { activate, ADMIN_TOKEN, baseEnv, cid, claimAndRead, getConv, inboundPayload, makeHarness, post, WA, type Harness } from "./helpers";

const wasm = new WebAssembly.Module(readFileSync(new URL("../lib/wasm/voice-opus.wasm", import.meta.url)));

/** 16-bit PCM WAV of a tone (what melotts returns, observed live), `seconds` long. */
function wav(seconds: number, rate = 44100, channels = 1): Uint8Array {
  const n = Math.round(seconds * rate);
  const b = new Uint8Array(44 + n * 2 * channels);
  const dv = new DataView(b.buffer);
  const s = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  s(0, "RIFF"); dv.setUint32(4, 36 + n * 2 * channels, true); s(8, "WAVE"); s(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2 * channels, true); dv.setUint16(32, 2 * channels, true); dv.setUint16(34, 16, true);
  s(36, "data"); dv.setUint32(40, n * 2 * channels, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) dv.setInt16(44 + (i * channels + c) * 2, Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), true);
  return b;
}

test("encoder: WAV (mono or stereo, any common rate) -> mono Ogg Opus with the right length; caps and junk give codes", async () => {
  for (const [rate, ch] of [[44100, 1], [24000, 1], [16000, 1], [48000, 2]] as const) {
    const r = await encodeVoiceNote(wasm, wav(2.5, rate, ch), { maxSeconds: 10 });
    assert.ok(isMonoOggOpus(r.ogg), `mono Ogg Opus for ${rate}/${ch}`);
    assert.ok(Math.abs(r.seconds - 2.5) < 0.05, `duration ${r.seconds}`);
    assert.ok(Math.abs((oggOpusSeconds(r.ogg) ?? 0) - 2.5) < 0.05, "granule-based duration matches");
    assert.ok(r.ogg.length < 2.5 * 4000, "about 24 kbit/s");
    assert.equal(r.packets, 125, "20 ms packets");
  }
  const mp3 = await encodeVoiceNote(wasm, new Uint8Array(readFileSync(new URL("./fixtures/tone-1.5s.mp3", import.meta.url))), { maxSeconds: 10 });
  assert.ok(isMonoOggOpus(mp3.ogg), "MP3 input (the documented melotts format) works too");
  assert.ok(Math.abs(mp3.seconds - 1.5) < 0.1, `mp3 duration ${mp3.seconds}`);
  await assert.rejects(encodeVoiceNote(wasm, wav(12), { maxSeconds: 10 }), (e: unknown) => e instanceof VoiceEncodeError && e.code === "encode_too_long");
  await assert.rejects(encodeVoiceNote(wasm, new Uint8Array(500).fill(9), { maxSeconds: 10 }), (e: unknown) => e instanceof VoiceEncodeError && e.code === "encode_no_audio");
});

test("Ogg muxer: valid page CRCs and end-trimmed granule (RFC 7845)", () => {
  const ogg = muxOggOpus([new Uint8Array([0xf8, 1, 2]), new Uint8Array([0xf8, 3])], { preSkip: 312, samples48: 1500, inputRate: 16000 });
  assert.equal(String.fromCharCode(...ogg.subarray(0, 4)), "OggS");
  assert.equal(oggOpusSeconds(ogg), 1500 / 48000);
  // every page's CRC verifies
  let o = 0;
  while (o < ogg.length) {
    const segs = ogg[o + 26]!;
    const len = 27 + segs + [...ogg.subarray(o + 27, o + 27 + segs)].reduce((a, b) => a + b, 0);
    const page = ogg.slice(o, o + len);
    const crc = new DataView(page.buffer).getUint32(22, true);
    page.fill(0, 22, 26);
    let c = 0;
    for (const byte of page) { c ^= byte << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; c >>>= 0; }
    assert.equal(c, crc);
    o += len;
  }
});

test("languages: MeloTTS has no Arabic; the script of the text decides over the agent's hint", () => {
  assert.deepEqual(Object.keys(ttsLanguages("@cf/myshell-ai/melotts")), ["en", "fr", "es", "zh", "ja", "ko"]);
  assert.deepEqual(Object.keys(ttsLanguages("@cf/deepgram/aura-1")), ["en"]);
  assert.equal(ttsLanguages("@cf/myshell-ai/melotts").ar, undefined);
  assert.equal(scriptLanguage("مرحبا، طلبك جاهز"), "ar");
  assert.equal(scriptLanguage("Bonjour, c'est prêt"), null);
  const c = { messages: [{ id: "a", dir: "in", type: "audio", text: "[voice note, transcribed, language: fr] Bonjour", ts: 1, media: { kind: "audio", st: "done", lang: "fr" } }] } as unknown as Conv;
  assert.equal(voiceLanguage(c, "Votre commande est prête"), "fr", "from the customer's voice note");
  assert.equal(voiceLanguage(c, "Your order is ready", "en"), "en", "the agent's hint");
  assert.equal(voiceLanguage(c, "طلبك جاهز", "en"), "ar", "Arabic script wins over a wrong hint");
  assert.equal(speakable("See **this** https://x.example/a?b=1 now"), "See this now");
});

test("modes: off by default; mirror answers voice with voice only; on also obeys reply_as voice; text always wins", () => {
  const voiceConv = { messages: [{ id: "a", dir: "in", type: "audio", text: "[voice note, transcribed] hi", ts: 1 }] } as unknown as Conv;
  const textConv = { messages: [{ id: "a", dir: "in", type: "text", text: "hi", ts: 1 }] } as unknown as Conv;
  const off = loadConfig(baseEnv());
  const mirror = loadConfig(baseEnv({ VOICE_REPLIES: "mirror" }));
  const on = loadConfig(baseEnv({ VOICE_REPLIES: "on" }));
  assert.equal(off.voiceReplies, "off");
  assert.deepEqual(chooseVoice(off, voiceConv, undefined), { voice: false });
  assert.deepEqual(chooseVoice(off, voiceConv, "voice"), { voice: false, reason: "voice_replies_off" });
  assert.deepEqual(chooseVoice(mirror, voiceConv, undefined), { voice: true });
  assert.deepEqual(chooseVoice(mirror, textConv, undefined), { voice: false });
  assert.equal(chooseVoice(mirror, textConv, "voice").voice, false);
  assert.deepEqual(chooseVoice(mirror, voiceConv, "text"), { voice: false });
  assert.deepEqual(chooseVoice(on, textConv, "voice"), { voice: true });
  assert.deepEqual(chooseVoice(on, textConv, undefined), { voice: false });
  assert.deepEqual(chooseVoice(on, voiceConv, undefined), { voice: true });
  assert.equal(loadConfig(baseEnv({ VOICE_REPLIES: "banana" })).voiceReplies, "off");
});

test("speak(): MeloTTS audio (base64 JSON) goes through the encoder; a mono Ogg Opus answer (Aura) is used as is; errors are codes", async () => {
  const a: SpeakArgs = { text: "Your order is ready.", lang: "en", model: "@cf/myshell-ai/melotts", maxSeconds: 30, timeoutMs: 5000 };
  const w = wav(1.2, 44100);
  const b64 = Buffer.from(w).toString("base64");
  const enc = async (input: Uint8Array) => { const r = await encodeVoiceNote(wasm, input, { maxSeconds: 30 }); return { ok: true as const, ogg: r.ogg, seconds: r.seconds }; };
  const seen: Record<string, unknown>[] = [];
  const r = await speak({ run: async (_m, input) => { seen.push(input); return { audio: b64 }; } }, enc, a);
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0], { prompt: "Your order is ready.", lang: "en" });
  const ogg = (r as { ogg: Uint8Array }).ogg;
  let encoderCalls = 0;
  const aura = await speak({ run: async (_m, input) => { seen.push(input); return new Response(ogg as unknown as BodyInit).body; } }, async () => { encoderCalls++; return { ok: false, code: "x" }; }, { ...a, model: "@cf/deepgram/aura-1" });
  assert.equal(aura.ok, true);
  assert.equal(encoderCalls, 0, "already Ogg Opus: no re-encode");
  assert.deepEqual(seen[1], { text: "Your order is ready.", encoding: "opus", container: "ogg" });
  const quota = await speak({ run: async () => { throw new Error("3036: you have used up your daily free allocation of 10,000 neurons"); } }, enc, a);
  assert.deepEqual(quota, { ok: false, code: "voice_tts_ai_3036", count: { voice_tts_failed: 1 } });
  const ar = await speak({ run: async () => ({}) }, enc, { ...a, lang: "ar" });
  assert.equal((ar as { code: string }).code, "voice_language_unsupported_ar");
});

// ---------------------------------------------------------------- send_reply end to end (fake Meta, fake speaker)

const OGG = muxOggOpus([new Uint8Array([0xf8, 0xff, 0xfe])], { preSkip: 312, samples48: 960, inputRate: 16000 });

function voiceHarness(env: Record<string, string> = {}, speaker?: (a: SpeakArgs) => Promise<SpeakResult>, upload: { status?: number } = {}) {
  const h = makeHarness({ VOICE_REPLIES: "mirror", ...env });
  const spoken: SpeakArgs[] = [];
  h.ctx.speakVoice = async (a) => { spoken.push(a); return speaker ? speaker(a) : { ok: true, ogg: OGG, seconds: 2, ttsBytes: 1000 }; };
  const uploads: { auth: boolean; type: string | null; fileType: string | null }[] = [];
  const inner = h.ctx.fetch;
  h.ctx.fetch = async (input, init) => {
    const url = String(input);
    if (/^https:\/\/graph\.facebook\.com\/v[\d.]+\/\d+\/media$/.test(url)) {
      const f = init?.body as FormData;
      const file = f.get("file") as Blob | null;
      uploads.push({ auth: new Headers(init?.headers as HeadersInit).has("authorization"), type: f.get("type") as string | null, fileType: file?.type ?? null });
      if (upload.status) return Response.json({ error: { code: 100 } }, { status: upload.status });
      return Response.json({ id: "990000000000001" });
    }
    return inner(input, init);
  };
  return { h, spoken, uploads };
}
const sends = (h: Harness) => h.net.graph.filter((c) => /\/messages$/.test(c.url));
const voiceNoteIn = (wamid: string) => inboundPayload({ wamid, type: "audio", extra: { audio: { id: "M1", mime_type: "audio/ogg; codecs=opus", voice: true } } });
async function metrics(h: Harness) { return (await h.store.get<MediaMetrics>(MEDIA_METRICS_KEY))?.value; }

test("mirror: a voice note gets a voice note (audio, voice: true); the text is stored in history; counted", async () => {
  const { h, spoken, uploads } = voiceHarness();
  await activate(h);
  await post(h, voiceNoteIn("wamid.IN1"));
  const lease = await claimAndRead(h);
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "Your two lattes are ready in ten minutes.", voice_language: "en" });
  assert.equal(r.ok, true);
  assert.equal(r.sent_as, "voice");
  assert.equal(spoken.length, 1);
  assert.deepEqual(spoken[0], { text: "Your two lattes are ready in ten minutes.", lang: "en", model: "@cf/myshell-ai/melotts", maxSeconds: 45, timeoutMs: 15000 });
  assert.deepEqual(uploads, [{ auth: true, type: "audio/ogg; codecs=opus", fileType: "audio/ogg; codecs=opus" }]);
  const s = sends(h);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.body.type, "audio");
  assert.deepEqual(s[0]!.body.audio, { id: "990000000000001", voice: true });
  assert.equal(s[0]!.body.to, WA);
  const out = (await getConv(h)).messages.filter((m) => m.dir === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, "audio");
  assert.equal(out[0]!.text, "Your two lattes are ready in ten minutes.", "the reply text is kept");
  assert.equal((await getConv(h)).outs[out[0]!.rk!]!.kind, "voice");
  const m = await metrics(h);
  assert.equal(m?.today.voice_sent, 1);
  assert.equal(m?.today.voice_seconds, 2);
  const ov: any = await getOverview(h.ctx, null);
  assert.equal(ov.media.voice_replies, "mirror");
  assert.equal(ov.media.today.voice_sent, 1);
});

test("fallbacks send the TEXT: Arabic (no voice), model error, upload error, too long; each counted once; no retry", async () => {
  const cases: [string, Parameters<typeof voiceHarness>, string, keyof MediaMetrics["today"] | null][] = [
    ["طلبك جاهز خلال عشر دقائق", [{}], "voice_language_unsupported_ar", "voice_language_unsupported"],
    ["Ready soon", [{}, async () => ({ ok: false, code: "voice_tts_ai_3036", count: { voice_tts_failed: 1 } })], "voice_tts_ai_3036", "voice_tts_failed"],
    ["Ready soon", [{}, undefined, { status: 500 }], "voice_upload_http_500", "voice_upload_failed"],
    ["x".repeat(500), [{}], "voice_too_long", null],
  ];
  for (const [text, args, code, counter] of cases) {
    const { h, spoken } = voiceHarness(...args);
    await activate(h);
    await post(h, voiceNoteIn("wamid.IN1"));
    const lease = await claimAndRead(h);
    const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text, voice_language: "en" });
    assert.equal(r.ok, true, code);
    assert.equal(r.sent_as, "text");
    assert.equal(r.voice_fallback, code);
    const s = sends(h);
    assert.equal(s.length, 1, "exactly one send: the text");
    assert.equal(s[0]!.body.type, "text");
    assert.equal(s[0]!.body.text.body, text);
    assert.ok(spoken.length <= 1, "no retry");
    const m = await metrics(h);
    assert.equal(m?.today.voice_fallback, 1);
    if (counter) assert.equal(m?.today[counter], 1);
    assert.equal(m?.last_failure_code, code);
  }
});

test("guards come first: test-mode recipient, unseen messages and replays never reach text-to-speech", async () => {
  const { h, spoken } = voiceHarness({ LAUNCH_MODE: "test", TEST_RECIPIENTS: "15550000999" });
  await activate(h);
  await post(h, voiceNoteIn("wamid.IN1"));
  const lease = await claimAndRead(h);
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "hi", voice_language: "en" });
  assert.equal(r.error, "blocked_test_mode_recipient_not_allowlisted");
  assert.equal(spoken.length, 0);

  const b = voiceHarness();
  await activate(b.h);
  await post(b.h, voiceNoteIn("wamid.IN1"));
  const l2 = await claimAndRead(b.h);
  const first: any = await sendReply(b.h.ctx, { conversation_id: cid(), lease: l2, text: "hi", voice_language: "en", idempotency_key: "k1" });
  assert.equal(first.sent_as, "voice");
  const again: any = await sendReply(b.h.ctx, { conversation_id: cid(), lease: l2, text: "hi", voice_language: "en", idempotency_key: "k1" });
  assert.equal(again.idempotent_replay, true);
  assert.equal(b.spoken.length, 1, "a replay does not speak again");
  await post(b.h, voiceNoteIn("wamid.IN2"));
  const unseen: any = await sendReply(b.h.ctx, { conversation_id: cid(), lease: l2, text: "more", voice_language: "en" });
  assert.equal(unseen.error, "unseen_inbound_messages");
  assert.equal(b.spoken.length, 1);
});

test("off (default) never speaks; a text conversation in mirror mode stays text, even when the agent asks for voice", async () => {
  const off = voiceHarness({ VOICE_REPLIES: "off" });
  await activate(off.h);
  await post(off.h, voiceNoteIn("wamid.IN1"));
  const l = await claimAndRead(off.h);
  const r: any = await sendReply(off.h.ctx, { conversation_id: cid(), lease: l, text: "hi", reply_as: "voice" });
  assert.equal(r.sent_as, "text");
  assert.equal(r.voice_fallback, "voice_replies_off");
  assert.equal(off.spoken.length, 0);
  assert.equal((await metrics(off.h))?.today.voice_fallback ?? 0, 0, "a switched-off feature is not a failure");

  const m = voiceHarness();
  await activate(m.h);
  await post(m.h, inboundPayload({ wamid: "wamid.T1", text: "hello" }));
  const l2 = await claimAndRead(m.h);
  const t: any = await sendReply(m.h.ctx, { conversation_id: cid(), lease: l2, text: "hi" });
  assert.equal(t.sent_as, "text");
  assert.equal(t.voice_fallback, undefined);
  assert.equal(m.spoken.length, 0);
  const forced: any = await sendReply(m.h.ctx, { conversation_id: cid(), lease: l2, text: "hi again", reply_as: "voice" });
  assert.equal(forced.voice_fallback, "mirror_mode_customer_did_not_send_a_voice_note");
});

test("Meta refusing the voice note itself: failed, counted, hint to resend as text (no automatic second send)", async () => {
  const { h } = voiceHarness();
  await activate(h);
  await post(h, voiceNoteIn("wamid.IN1"));
  const lease = await claimAndRead(h);
  h.net.graphStatus = 400;
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease, text: "hi", voice_language: "en" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "send_rejected_http_400");
  assert.equal(r.sent_as, "voice");
  assert.match(r.hint, /reply_as "text"/);
  assert.equal(sends(h).length, 1);
  assert.equal((await metrics(h))?.today.voice_send_rejected, 1);
  const out = (await getConv(h)).messages.filter((m) => m.dir === "out");
  assert.equal(out[0]!.status, "failed");
  assert.equal(out[0]!.text, "hi", "the text stays in history");
});

test("voice self-test route: 404 unless MEDIA_SELFTEST=1, owner token only, real sends only to TEST_RECIPIENTS in test mode", async () => {
  const req = (q: string, token = ADMIN_TOKEN, body = "Hello there") =>
    new Request("https://bridge.example.test/api/admin/voice-selftest" + q, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
  assert.equal((await adminVoiceSelftest(makeHarness().ctx, req("?lang=en"))).status, 404);
  const { h, spoken } = voiceHarness({ MEDIA_SELFTEST: "1", LAUNCH_MODE: "test", TEST_RECIPIENTS: "15550000999" });
  assert.equal((await adminVoiceSelftest(h.ctx, req("?lang=en", "wrong-token-0000000000"))).status, 401);
  assert.equal((await adminVoiceSelftest(h.ctx, req("?lang=english"))).status, 400);
  const ok: any = await (await adminVoiceSelftest(h.ctx, req("?lang=en&upload=1"))).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.mono_ogg_opus, true);
  assert.equal(ok.upload.media_id_returned, true);
  assert.equal(sends(h).length, 0, "upload only: nothing is sent");
  const refused: any = await (await adminVoiceSelftest(h.ctx, req("?lang=en&send=1&to=15550000001"))).json();
  assert.equal(refused.error, "send_only_to_test_recipients_in_test_mode");
  await activate(h);
  const sent: any = await (await adminVoiceSelftest(h.ctx, req("?lang=en&send=1&to=15550000999"))).json();
  assert.equal(sent.ok, true);
  assert.equal(sent.result.sent_as, "voice");
  assert.equal(sent.stored_type, "audio");
  assert.equal(sent.stored_text_kept, true);
  assert.equal(sent.erased, true, "the self-test conversation is erased");
  assert.equal(sends(h).length, 1);
  assert.equal(sends(h)[0]!.body.to, "15550000999");
  assert.equal(spoken.length, 2);
});
