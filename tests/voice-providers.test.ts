// Voice-note reply providers (docs/VOICE-REPLIES.md): provider choice (Workers AI, xAI, ElevenLabs), the requests each provider gets, error
// and quota codes, send_reply end to end with the text fallback, the optional dialect presets and pronunciation list (spoken copy only),
// and the keys never leaving in logs or results. All ids and keys below are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config";
import { scrub } from "../lib/admin-mcp";
import { MEDIA_METRICS_KEY, type MediaMetrics } from "../lib/media";
import { getOverview } from "../lib/overview";
import { redactShapes } from "../lib/redact";
import { getHistory, sendReply, claimConversation } from "../lib/tools";
import { elevenLabsErrorCode, speakElevenLabs, type ElevenLabsArgs } from "../lib/tts-elevenlabs";
import { speakXai, xaiLanguage, XAI_TTS_URL } from "../lib/tts-xai";
import { muxOggOpus } from "../lib/voice-encode";
import { synthesize, ttsProviderFor, voiceLanguagesOf, type SpeakArgs } from "../lib/voice-reply";
import { DIALECT_STYLES, spokenStyle, styleTagOf } from "../lib/voice-style";
import { LEBANESE_SHADDA, parsePronunciations, spokenCopy } from "../lib/voice-pronounce";
import { activate, baseEnv, cid, getConv, inboundPayload, makeHarness, post, WA } from "./helpers";

const KEY = "sk" + "_" + "f0e1d2c3b4a5".repeat(4); // synthetic, built at run time so no key-shaped literal is in the file
const XKEY = "xai" + "-" + "a1b2c3d4e5f6".repeat(4);
const VOICE = "AbCdEf0123456789XyZw";
const OGG = muxOggOpus([new Uint8Array([0xf8, 0xff, 0xfe])], { preSkip: 312, samples48: 960, inputRate: 48000 }); // a tiny mono Ogg Opus file
const EL_ENV = { VOICE_REPLIES: "mirror", VOICE_REPLY_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: VOICE };
const AR = "أكيد، منحجزلك موعد بكرا الساعة عشرة. أهلا وسهلا!";

test("config: voice replies stay off by default; provider workers-ai; no dialect, no style tag, no pronunciations by default", () => {
  const d = loadConfig(baseEnv());
  assert.equal(d.voiceReplies, "off");
  assert.equal(d.voiceReplyProvider, "workers-ai");
  assert.equal(d.elevenlabsApiKey, undefined);
  assert.equal(d.elevenlabsModelId, "eleven_v4");
  assert.equal(d.elevenlabsMaxChars, 600);
  assert.equal(d.arabicReplyDialect, "none");
  assert.equal(d.voiceStyleTag, undefined);
  assert.deepEqual(d.voicePronunciations, {});
  assert.equal(d.xaiTtsVoice, "eve");
  const c = loadConfig(baseEnv({ ...EL_ENV, ELEVENLABS_MODEL_ID: "eleven_v3", ELEVENLABS_MAX_CHARS: "5000", ARABIC_REPLY_DIALECT: "Gulf", VOICE_STYLE_TAG: "warm, friendly" }));
  assert.equal(c.voiceReplyProvider, "elevenlabs");
  assert.equal(c.elevenlabsVoiceId, VOICE);
  assert.equal(c.elevenlabsModelId, "eleven_v3");
  assert.equal(c.elevenlabsMaxChars, 1500, "capped");
  assert.equal(c.arabicReplyDialect, "gulf");
  assert.equal(c.voiceStyleTag, "[warm, friendly]");
  assert.equal(loadConfig(baseEnv({ ARABIC_REPLY_DIALECT: "klingon" })).arabicReplyDialect, "none");
  assert.equal(loadConfig(baseEnv({ VOICE_REPLY_PROVIDER: "XAI" })).voiceReplyProvider, "xai");
  assert.equal(loadConfig(baseEnv({ ELEVENLABS_VOICE_ID: "../bad/id" })).elevenlabsVoiceId, undefined);
  assert.equal(loadConfig(baseEnv({ ELEVENLABS_MODEL_ID: "Bad Model!" })).elevenlabsModelId, "eleven_v4");
  assert.equal(loadConfig(baseEnv({ XAI_TTS_VOICE: "a b" })).xaiTtsVoice, "eve");
  assert.equal(loadConfig(baseEnv({ XAI_TTS_ARABIC_LOCALE: "ar-AE" })).xaiTtsArabicLocale, "ar-AE");
  assert.equal(loadConfig(baseEnv({ XAI_TTS_ARABIC_LOCALE: "ar-LB" })).xaiTtsArabicLocale, undefined);
  assert.equal(styleTagOf("[x] [y]"), undefined, "no nested tags");
});

test("dialect presets: generic language guidance only, selectable, none by default", () => {
  assert.equal(spokenStyle("none"), null);
  for (const d of ["msa", "lebanese", "gulf", "egyptian"] as const) {
    const s = spokenStyle(d)!;
    assert.ok(s.length > 100, d);
    assert.ok(/SPOKEN/.test(s), d);
    assert.ok(!/shop|Beirut|menu|table|ticket/i.test(s), `${d}: no business wording`);
  }
  assert.ok(DIALECT_STYLES.lebanese.includes("هلّق"));
  for (const w of LEBANESE_SHADDA) assert.ok(w.includes("\u0651"), `${w} carries shadda`);
  assert.equal(xaiLanguage("ar", "egyptian"), "ar-EG");
  assert.equal(xaiLanguage("ar", "gulf"), "ar-AE");
  assert.equal(xaiLanguage("ar", "lebanese"), "ar-SA");
  assert.equal(xaiLanguage("ar", "lebanese", "ar-AE"), "ar-AE", "owner override");
  assert.equal(xaiLanguage("de", "none"), "de");
  assert.equal(xaiLanguage("sw", "none"), "auto");
});

test("pronunciation list: JSON or pairs, malformed entries skipped, whole words only, Arabic clitics kept, owner entry wins", () => {
  assert.deepEqual(parsePronunciations('{"Acme":"Akmee","x":5}'), { Acme: "Akmee" });
  assert.deepEqual(parsePronunciations("Acme => Akmee; WAB=wab\nbad line"), { Acme: "Akmee", WAB: "wab" });
  assert.deepEqual(parsePronunciations("{broken"), {});
  assert.deepEqual(parsePronunciations("a=[tag]"), {}, "no brackets: a list cannot inject audio tags");
  const p = { Acme: "Akmee", "الساعة": "السيعة" };
  const t = (s: string, dialect: "none" | "lebanese" = "none") => spokenCopy(s, { lang: "ar", dialect, pronunciations: p }).text;
  assert.equal(t("acme, Acmes and ACME"), "Akmee, Acmes and Akmee", "whole words, any case");
  assert.equal(t("الساعة بالساعة والساعة مساعدة"), "السيعة بالسيعة والسيعة مساعدة", "clitics kept, no partial matches");
  assert.equal(t("بدك هلق", "lebanese"), "بدّك هلّق", "preset marks for Arabic");
  assert.equal(t("بدك هلق"), "بدك هلق", "no preset: untouched");
  assert.equal(spokenCopy("بدك", { lang: "en", dialect: "lebanese" }).text, "بدك", "preset only for Arabic replies");
  assert.equal(spokenCopy("هلّق", { lang: "ar", dialect: "lebanese" }).changes, 0, "idempotent");
});

test("provider choice: ElevenLabs speaks every language by default; VOICE_REPLY_ROUTING=non-workers-ai keeps the 0.4.x split", () => {
  const wa = loadConfig(baseEnv());
  assert.equal(ttsProviderFor(wa, "ar"), null, "no Arabic without ElevenLabs");
  assert.equal(ttsProviderFor(wa, "en"), "workers-ai");
  const el = loadConfig(baseEnv(EL_ENV));
  assert.equal(ttsProviderFor(el, "ar"), "elevenlabs");
  assert.equal(ttsProviderFor(el, "de"), "elevenlabs", "MeloTTS has no German");
  for (const l of ["en", "fr", "es", "zh", "ja", "ko"]) assert.equal(ttsProviderFor(el, l), "elevenlabs", l);
  assert.deepEqual(voiceLanguagesOf(el), ["ar", "en", "fr", "es", "zh", "ja", "ko", "*"]);
  const old = loadConfig(baseEnv({ ...EL_ENV, VOICE_REPLY_ROUTING: "non-workers-ai" }));
  assert.equal(ttsProviderFor(old, "ar"), "elevenlabs");
  assert.equal(ttsProviderFor(old, "de"), "elevenlabs");
  for (const l of ["en", "fr", "es", "zh", "ja", "ko"]) assert.equal(ttsProviderFor(old, l), "workers-ai", l);
});

function fakeEl(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers as HeadersInit), body: init?.body ? JSON.parse(String(init.body)) : null });
    return answer(url, init ?? {});
  }) as typeof fetch;
  return { f, calls };
}
const args = (o: Partial<ElevenLabsArgs> = {}): ElevenLabsArgs => ({ text: AR, apiKey: KEY, voiceId: VOICE, modelId: "eleven_v4", maxChars: 600, maxSeconds: 45, timeoutMs: 5000, ...o });

test("speakElevenLabs: one POST with the key in xi-api-key only, Ogg Opus 48 kHz asked for, used as is", async () => {
  const { f, calls } = fakeEl(() => new Response(OGG as unknown as BodyInit, { headers: { "content-type": "audio/opus" } }));
  const r = await speakElevenLabs(f, args());
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=opus_48000_64`);
  assert.equal(calls[0]!.headers.get("xi-api-key"), KEY);
  assert.equal(calls[0]!.headers.get("authorization"), null);
  assert.deepEqual(calls[0]!.body, { text: AR, model_id: "eleven_v4" });
  assert.ok(!calls[0]!.url.includes(KEY), "never in the URL");
  if (r.ok) { assert.equal(r.provider, "elevenlabs"); assert.deepEqual([...r.ogg], [...OGG], "the file as ElevenLabs sent it, not re-encoded"); }
});

test("speakElevenLabs: errors and quota become short codes; caps and a missing key make no call", async () => {
  const cases: [Response | Error, string, number][] = [
    [Response.json({ detail: { status: "quota_exceeded", message: "This request exceeds your quota" } }, { status: 401 }), "voice_tts_el_quota", 1],
    [Response.json({ detail: { status: "too_many_concurrent_requests" } }, { status: 429 }), "voice_tts_el_rate_limited", 1],
    [Response.json({ detail: { status: "invalid_api_key" } }, { status: 401 }), "voice_tts_el_auth", 0],
    [Response.json({ detail: { status: "voice_not_found" } }, { status: 404 }), "voice_tts_el_voice_not_found", 0],
    [Response.json({ detail: { status: "model_not_found" } }, { status: 400 }), "voice_tts_el_model", 0],
    [new Response("oops", { status: 503 }), "voice_tts_el_http_503", 0],
    [new Response(new Uint8Array(200).fill(7)), "voice_tts_el_not_ogg_opus", 0],
    [new Error("socket hang up"), "voice_tts_el_network", 0],
  ];
  for (const [answer, code, quota] of cases) {
    const { f } = fakeEl(() => { if (answer instanceof Error) throw answer; return answer.clone(); });
    const r = await speakElevenLabs(f, args());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, code);
      assert.equal(r.count.voice_tts_failed, 1, code);
      assert.equal(r.count.voice_el_quota ?? 0, quota, code);
      assert.ok(!JSON.stringify(r).includes("exceeds your quota"), "the provider's message is never echoed");
    }
  }
  const { f, calls } = fakeEl(() => new Response(OGG as unknown as BodyInit));
  assert.deepEqual(await speakElevenLabs(f, args({ text: "ا".repeat(601) })), { ok: false, code: "voice_too_long", count: {} });
  assert.equal((await speakElevenLabs(f, args({ apiKey: "" }))).ok, false);
  assert.equal((await speakElevenLabs(f, args({ voiceId: "" }))).ok, false);
  assert.equal(calls.length, 0);
  assert.equal(elevenLabsErrorCode(401, { detail: { status: "<script>" } }), "voice_tts_el_auth", "odd status words are ignored");
});

// ---------------------------------------------------------------- send_reply end to end (fake Meta, fake ElevenLabs)

function elHarness(env: Record<string, string> = {}, el: () => Response = () => new Response(OGG as unknown as BodyInit, { headers: { "content-type": "audio/opus" } })) {
  const h = makeHarness({ ...EL_ENV, ...env });
  const spokenByWorkersAi: SpeakArgs[] = [];
  h.ctx.speakVoice = async (a) => { spokenByWorkersAi.push(a); return { ok: true, ogg: OGG, seconds: 2, ttsBytes: 1000, provider: "workers-ai" }; };
  const elCalls: string[] = [];
  const elBodies: any[] = [];
  const uploads: string[] = [];
  const inner = h.ctx.fetch;
  h.ctx.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.elevenlabs.io/")) { elCalls.push(url); elBodies.push(JSON.parse(String(init?.body))); return el(); }
    if (/^https:\/\/graph\.facebook\.com\/v[\d.]+\/\d+\/media$/.test(url)) {
      const file = (init?.body as FormData).get("file") as Blob;
      uploads.push(`${file.type}:${file.size}`);
      return Response.json({ id: "990000000000002" });
    }
    return inner(input, init);
  };
  return { h, elCalls, elBodies, uploads, spokenByWorkersAi };
}
const voiceNoteIn = (wamid: string) => inboundPayload({ wamid, type: "audio", extra: { audio: { id: "M1", mime_type: "audio/ogg; codecs=opus", voice: true } } });
const sends = (h: ReturnType<typeof makeHarness>) => h.net.graph.filter((c) => /\/messages$/.test(c.url));
async function metrics(h: ReturnType<typeof makeHarness>) { return (await h.store.get<MediaMetrics>(MEDIA_METRICS_KEY))?.value; }

test("mirror + elevenlabs: an Arabic reply to a voice note goes out as an ElevenLabs voice note; text kept; counted; key never logged", async () => {
  const { h, elCalls, uploads, spokenByWorkersAi } = elHarness();
  await activate(h);
  await post(h, voiceNoteIn("wamid.IN1"));
  const c: any = await claimConversation(h.ctx, cid());
  const hist: any = await getHistory(h.ctx, cid(), c.lease);
  assert.equal(hist.voice_reply.expected, true);
  assert.equal(hist.voice_reply.provider, "elevenlabs");
  assert.equal(hist.voice_reply.max_chars, 400, "the smaller of VOICE_MAX_CHARS and ELEVENLABS_MAX_CHARS");
  assert.equal(hist.voice_reply.arabic_style, undefined, "no dialect preset unless the owner picks one");
  assert.equal(hist.voice_reply.dialect, "none");
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text: AR });
  assert.equal(r.ok, true);
  assert.equal(r.sent_as, "voice");
  assert.equal(elCalls.length, 1);
  assert.equal(spokenByWorkersAi.length, 0, "Arabic never goes to Workers AI");
  assert.deepEqual(uploads, [`audio/ogg; codecs=opus:${OGG.length}`]);
  const s = sends(h);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.body.type, "audio");
  assert.deepEqual(s[0]!.body.audio, { id: "990000000000002", voice: true });
  assert.equal(s[0]!.body.to, WA);
  assert.equal((await getConv(h)).messages.filter((m) => m.dir === "out")[0]!.text, AR);
  const m = await metrics(h);
  assert.equal(m?.today.voice_sent, 1);
  assert.equal(m?.today.voice_el_sent, 1);
  assert.equal(m?.today.voice_el_chars, AR.length);
  const ov: any = await getOverview(h.ctx, null);
  assert.equal(ov.media.voice_reply_provider, "elevenlabs");
  assert.deepEqual(ov.media.elevenlabs, {
    key_present: true, voice_id_set: true, model_id: "eleven_v4", max_chars: 600, style_tag_set: false,
    voices: { "*": VOICE }, model_ids: {}, style_tag_languages: [], pronunciation_dictionaries: { "*": [] }, ignored_entries: { voice_ids: 0, model_ids: 0, style_tags: 0, pronunciation_dictionaries: 0 },
  });
  assert.ok(h.logs.some((l) => l.event === "voice_prepared" && l.fields?.provider === "elevenlabs"));
  assert.ok(!JSON.stringify(h.logs).includes(KEY), "the key is never in a log line");
  assert.ok(!JSON.stringify(ov).includes(KEY), "nor in the overview");
});

test("ElevenLabs quota or error, or a reply over the cap: the TEXT goes instead, once; counted", async () => {
  const quota = () => Response.json({ detail: { status: "quota_exceeded" } }, { status: 401 });
  const cases: [string, () => Response, Record<string, string>, string][] = [
    [AR, quota, {}, "voice_tts_el_quota"],
    [AR, () => new Response("x", { status: 500 }), {}, "voice_tts_el_http_500"],
    ["ا".repeat(450), () => new Response(OGG as unknown as BodyInit), { VOICE_MAX_CHARS: "1500" }, "voice_too_long"],
  ];
  for (const [text, el, env, code] of cases) {
    const { h, elCalls } = elHarness(env, el);
    await activate(h);
    await post(h, voiceNoteIn("wamid.IN1"));
    const c: any = await claimConversation(h.ctx, cid());
    await getHistory(h.ctx, cid(), c.lease);
    const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text: code === "voice_too_long" ? "ا".repeat(601) : text });
    assert.equal(r.ok, true, code);
    assert.equal(r.sent_as, "text");
    assert.equal(r.voice_fallback, code);
    const s = sends(h);
    assert.equal(s.length, 1, "exactly one send: the text");
    assert.equal(s[0]!.body.type, "text");
    assert.ok(elCalls.length <= 1, "no retry");
    if (code === "voice_too_long") assert.equal(elCalls.length, 0, "over the cap: no ElevenLabs call");
    const m = await metrics(h);
    assert.equal(m?.today.voice_fallback, 1);
    if (code === "voice_tts_el_quota") assert.equal(m?.today.voice_el_quota, 1);
    assert.ok(!JSON.stringify(h.logs).includes(KEY));
  }
});

test("off by default even with an ElevenLabs key: no hint, no call; English stays on Workers AI with routing non-workers-ai", async () => {
  const { h, elCalls } = elHarness({ VOICE_REPLIES: "off" });
  await activate(h);
  await post(h, voiceNoteIn("wamid.IN1"));
  const c: any = await claimConversation(h.ctx, cid());
  const hist: any = await getHistory(h.ctx, cid(), c.lease);
  assert.equal(hist.voice_reply, undefined);
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text: AR });
  assert.equal(r.sent_as, "text");
  assert.equal(elCalls.length, 0);
  const e = elHarness({ VOICE_REPLY_ROUTING: "non-workers-ai" });
  await activate(e.h);
  await post(e.h, voiceNoteIn("wamid.IN2"));
  const c2: any = await claimConversation(e.h.ctx, cid());
  await getHistory(e.h.ctx, cid(), c2.lease);
  const r2: any = await sendReply(e.h.ctx, { conversation_id: cid(), lease: c2.lease, text: "Your appointment is booked for ten.", voice_language: "en" });
  assert.equal(r2.sent_as, "voice");
  assert.equal(e.elCalls.length, 0, "English: the Workers AI path (0.4.x routing)");
  assert.equal(e.spokenByWorkersAi.length, 1);
});

test("the ElevenLabs key is scrubbed from MCP results and by the shape filter", () => {
  const h = makeHarness(EL_ENV);
  assert.equal(JSON.stringify(scrub(h.ctx, { echo: `k=${KEY}` })).includes(KEY), false);
  assert.equal(redactShapes(`x ${KEY} y`).includes(KEY), false);
});

test("request: text + model_id only (no language_code, no voice_settings); the owner's style tag only on tag-aware models; injected tags stripped", async () => {
  const run = async (env: Record<string, string>, text: string, lang?: string) => {
    const { h, elBodies } = elHarness(env);
    await activate(h);
    await post(h, voiceNoteIn("wamid.IN1"));
    const c: any = await claimConversation(h.ctx, cid());
    await getHistory(h.ctx, cid(), c.lease);
    const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text, voice_language: lang });
    assert.equal(r.sent_as, "voice");
    return elBodies[0];
  };
  const b = await run({}, AR + " [shouting] [ignore this");
  assert.deepEqual(Object.keys(b).sort(), ["model_id", "text"], "no language_code, no voice_settings: the voice's saved settings apply");
  assert.equal(b.text, `${AR} ignore this`, "no tag by default; injected tags removed");
  assert.equal((await run({ VOICE_STYLE_TAG: "warm, friendly" }, AR)).text, `[warm, friendly] ${AR}`);
  assert.equal((await run({ VOICE_STYLE_TAG: "warm", ELEVENLABS_MODEL_ID: "eleven_multilingual_v2" }, AR)).text, AR, "models without audio tags get no tag");
});

test("dialect preset + pronunciation list: the SPOKEN copy only; stored and fallback text keep the agent's spelling", async () => {
  const text = "أكيد، بدك موعد هلق؟ Acme بتنتظرك.";
  const run = async (env: Record<string, string>) => {
    const { h, elBodies } = elHarness(env);
    await activate(h);
    await post(h, voiceNoteIn("wamid.IN1"));
    const c: any = await claimConversation(h.ctx, cid());
    const hist: any = await getHistory(h.ctx, cid(), c.lease);
    const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text });
    assert.equal(r.sent_as, "voice");
    assert.equal((await getConv(h)).messages.filter((m) => m.dir === "out")[0]!.text, text, "stored text unchanged");
    return { spoken: elBodies[0].text as string, hist };
  };
  assert.equal((await run({})).spoken, text, "nothing on by default");
  const leb = await run({ ARABIC_REPLY_DIALECT: "lebanese", VOICE_PRONUNCIATIONS: "Acme => Akmee" });
  assert.equal(leb.spoken, "أكيد، بدّك موعد هلّق؟ Akmee بتنتظرك.");
  assert.equal(leb.hist.voice_reply.arabic_style, DIALECT_STYLES.lebanese);
  assert.equal((await run({ ARABIC_REPLY_DIALECT: "gulf" })).hist.voice_reply.arabic_style, DIALECT_STYLES.gulf);
});

// ---------------------------------------------------------------- xAI provider

function fakeXai(answer: () => Response | Promise<Response>) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers as HeadersInit), body: init?.body ? JSON.parse(String(init.body)) : null });
    return answer();
  }) as typeof fetch;
  return { f, calls };
}
const MP3 = new Uint8Array(400).fill(0x55);
const encodeOk = async (b: Uint8Array) => ({ ok: true as const, ogg: OGG, seconds: 2, inBytes: b.length });

test("speakXai: one POST with the key as a Bearer header only, MP3 asked for, language and replace passed, then encoded", async () => {
  const { f, calls } = fakeXai(() => new Response(MP3 as unknown as BodyInit, { headers: { "content-type": "audio/mpeg" } }));
  let encoded = 0;
  const r = await speakXai(f, async (b, o) => { encoded = b.length; return encodeOk(b); }, { text: AR, apiKey: XKEY, voice: "ara", language: "ar-SA", maxChars: 600, maxSeconds: 45, timeoutMs: 5000, replace: { Acme: "Akmee" } });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, XAI_TTS_URL);
  assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${XKEY}`);
  assert.deepEqual(calls[0]!.body, { text: AR, voice_id: "ara", language: "ar-SA", output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 }, replace: { Acme: "Akmee" } });
  assert.equal(encoded, MP3.length);
  if (r.ok) assert.equal(r.provider, "xai");
});

test("speakXai: errors become short codes; no key or over the cap makes no call; nothing echoed", async () => {
  const cases: [Response | Error, string][] = [
    [new Response("bad key", { status: 401 }), "voice_tts_xai_auth"],
    [new Response("slow down", { status: 429 }), "voice_tts_xai_rate_limited"],
    [new Response("no credits", { status: 402 }), "voice_tts_xai_credits"],
    [new Response("x", { status: 500 }), "voice_tts_xai_http_500"],
    [new Error("reset"), "voice_tts_xai_network"],
  ];
  for (const [ans, code] of cases) {
    const { f } = fakeXai(() => { if (ans instanceof Error) throw ans; return ans.clone(); });
    const r = await speakXai(f, encodeOk, { text: AR, apiKey: XKEY, voice: "eve", language: "ar-SA", maxChars: 600, maxSeconds: 45, timeoutMs: 5000 });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.code, code); assert.ok(!JSON.stringify(r).includes(XKEY)); }
  }
  const { f, calls } = fakeXai(() => new Response(MP3 as unknown as BodyInit));
  assert.equal((await speakXai(f, encodeOk, { text: AR, apiKey: "", voice: "eve", language: "ar-SA", maxChars: 600, maxSeconds: 45, timeoutMs: 5000 })).ok, false);
  assert.deepEqual(await speakXai(f, encodeOk, { text: "ا".repeat(700), apiKey: XKEY, voice: "eve", language: "ar-SA", maxChars: 600, maxSeconds: 45, timeoutMs: 5000 }), { ok: false, code: "voice_too_long", count: {} });
  assert.equal(calls.length, 0);
});

test("provider xai: Arabic goes to the Durable Object speaker with the xAI request (no key in the call); English too by default, Workers AI with non-workers-ai", async () => {
  const h = makeHarness({ VOICE_REPLIES: "mirror", VOICE_REPLY_PROVIDER: "xai", XAI_API_KEY: XKEY, ARABIC_REPLY_DIALECT: "egyptian", VOICE_PRONUNCIATIONS: "Acme=Akmee", VOICE_REPLY_ROUTING: "non-workers-ai" });
  const seen: SpeakArgs[] = [];
  h.ctx.speakVoice = async (a) => { seen.push(a); return { ok: true, ogg: OGG, seconds: 2, ttsBytes: 1000, provider: a.xai ? "xai" : "workers-ai" }; };
  const cfg = loadConfig(baseEnv({ VOICE_REPLY_PROVIDER: "xai" }));
  assert.equal(ttsProviderFor(cfg, "ar"), "xai");
  assert.equal(ttsProviderFor(cfg, "en"), "xai", "every language by default");
  assert.equal(ttsProviderFor(loadConfig(baseEnv({ VOICE_REPLY_PROVIDER: "xai", VOICE_REPLY_ROUTING: "non-workers-ai" })), "en"), "workers-ai");
  const r = await synthesize(h.ctx, AR, "ar");
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.xai, { voice: "eve", language: "ar-EG", maxChars: h.ctx.cfg.voiceMaxChars, replace: { Acme: "Akmee" } });
  assert.ok(!JSON.stringify(seen).includes(XKEY), "the key is read inside the Durable Object, never passed");
  await synthesize(h.ctx, "Hello there.", "en");
  assert.equal(seen[1]!.xai, undefined);
  const ov: any = await getOverview(h.ctx, null);
  assert.deepEqual(ov.media.xai, { key_present: true, voice: "eve", arabic_locale: null });
  assert.ok(!JSON.stringify(ov).includes(XKEY));
  const nokey = makeHarness({ VOICE_REPLIES: "mirror", VOICE_REPLY_PROVIDER: "xai" });
  nokey.ctx.speakVoice = h.ctx.speakVoice;
  const r2 = await synthesize(nokey.ctx, AR, "ar");
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, "voice_tts_xai_key_missing");
});
