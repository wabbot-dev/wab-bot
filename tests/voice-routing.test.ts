// Voice-note reply routing and per-language voices (docs/VOICE-REPLIES.md#a-voice-per-language), and the gender-neutral address in the
// presets, the text-reply guidance and the call persona. Fake ElevenLabs and fake Meta only; every id and key below is synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config";
import { buildInstructions } from "../lib/call-persona";
import { createMcpRoute } from "../lib/mcp";
import { getOverview } from "../lib/overview";
import { claimConversation, getHistory, sendReply } from "../lib/tools";
import { muxOggOpus } from "../lib/voice-encode";
import { parseLangMap } from "../lib/voice-map";
import { elevenLabsVoiceFor, synthesize, ttsProviderFor, voiceLanguagesOf, voiceRoutingOf, type SpeakArgs } from "../lib/voice-reply";
import { DIALECT_STYLES, NEUTRAL_ADDRESS, spokenStyle } from "../lib/voice-style";
import { activate, baseEnv, cid, inboundPayload, makeHarness, MCP_TOKEN, post } from "./helpers";

const KEY = "sk" + "_" + "9a8b7c6d5e4f".repeat(4); // synthetic, built at run time
const V_DEF = "DefaultVoice00000001";
const V_AR = "ArabicVoice000000001";
const V_EN = "EnglishVoice00000001";
const OGG = muxOggOpus([new Uint8Array([0xf8, 0xff, 0xfe])], { preSkip: 312, samples48: 960, inputRate: 48000 });
const EL = { VOICE_REPLIES: "mirror", VOICE_REPLY_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: KEY };
const AR = "أهلا فيكن، الموعد بكرا الساعة عشرة.";
const EN = "Your appointment is booked for ten tomorrow.";

function harness(env: Record<string, string>) {
  const h = makeHarness({ ...EL, ...env });
  const workers: SpeakArgs[] = [];
  h.ctx.speakVoice = async (a) => { workers.push(a); return { ok: true, ogg: OGG, seconds: 2, ttsBytes: 1000, provider: "workers-ai" }; };
  const el: { voice: string; body: any }[] = [];
  const inner = h.ctx.fetch;
  h.ctx.fetch = async (input, init) => {
    const url = String(input);
    const m = /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/([A-Za-z0-9]+)\?/.exec(url);
    if (m) { el.push({ voice: m[1]!, body: JSON.parse(String(init?.body)) }); return new Response(OGG as unknown as BodyInit, { headers: { "content-type": "audio/opus" } }); }
    if (/^https:\/\/graph\.facebook\.com\/v[\d.]+\/\d+\/media$/.test(url)) return Response.json({ id: "990000000000003" });
    return inner(input, init);
  };
  return { h, el, workers };
}

test("parseLangMap: comma, semicolon, newline or JSON; bad entries skipped and counted, never thrown", () => {
  const id = (x: string) => (/^[A-Za-z0-9]{8,40}$/.test(x) ? x : undefined);
  assert.deepEqual(parseLangMap(`ar=${V_AR}, en=${V_EN}`, id), { map: { ar: V_AR, en: V_EN }, ignored: 0 });
  assert.deepEqual(parseLangMap(`AR : ${V_AR};\nen=${V_EN}`, id), { map: { ar: V_AR, en: V_EN }, ignored: 0 }, "case and spacing tolerated");
  assert.deepEqual(parseLangMap(JSON.stringify({ ar: V_AR, en: V_EN }), id), { map: { ar: V_AR, en: V_EN }, ignored: 0 });
  assert.deepEqual(parseLangMap(`ar=${V_AR},english=${V_EN},fr=../x,=${V_EN},garbage`, id), { map: { ar: V_AR }, ignored: 4 });
  assert.deepEqual(parseLangMap("{broken", id), { map: {}, ignored: 1 });
  assert.deepEqual(parseLangMap('["ar"]', id), { map: {}, ignored: 1 });
  assert.deepEqual(parseLangMap(JSON.stringify({ ar: 5, en: V_EN }), id), { map: { en: V_EN }, ignored: 1 });
  assert.deepEqual(parseLangMap(undefined, id), { map: {}, ignored: 0 });
  assert.deepEqual(parseLangMap("   ", id), { map: {}, ignored: 0 });
  const many = Array.from({ length: 50 }, (_, i) => `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}=${V_EN}`).join(",");
  assert.equal(Object.keys(parseLangMap(many, id).map).length, 40, "capped");
});

test("config: VOICE_REPLY_ROUTING defaults to all; per-language voices, models and style tags validated; bad entries never crash", () => {
  assert.equal(loadConfig(baseEnv()).voiceReplyRouting, "all");
  assert.equal(loadConfig(baseEnv({ VOICE_REPLY_ROUTING: "Non-Workers-AI " })).voiceReplyRouting, "non-workers-ai");
  assert.equal(loadConfig(baseEnv({ VOICE_REPLY_ROUTING: "sometimes" })).voiceReplyRouting, "all", "unknown value: the default");
  const c = loadConfig(baseEnv({
    ...EL, ELEVENLABS_VOICE_ID: V_DEF,
    ELEVENLABS_VOICE_IDS: `ar=${V_AR},en=${V_EN},fr=bad/id,zz9=${V_EN}`,
    ELEVENLABS_MODEL_IDS: "ar=eleven_v3,en=Bad Model",
    VOICE_STYLE_TAGS: "ar=[warm, slow]; en=calm, friendly; fr=[x] [y]",
  }));
  assert.deepEqual(c.elevenlabsVoiceIds, { ar: V_AR, en: V_EN });
  assert.deepEqual(c.elevenlabsModelIds, { ar: "eleven_v3" });
  assert.deepEqual(c.voiceStyleTags, { ar: "[warm, slow]", en: "[calm, friendly]" }, "commas stay inside a tag");
  assert.deepEqual(c.voiceMapIgnored, { voice_ids: 2, model_ids: 1, style_tags: 1 });
  const none = loadConfig(baseEnv());
  assert.deepEqual(none.elevenlabsVoiceIds, {});
  assert.deepEqual(none.voiceMapIgnored, { voice_ids: 0, model_ids: 0, style_tags: 0 });
});

test("voice per language: the language's own voice, model and tag, else ELEVENLABS_VOICE_ID / MODEL_ID / STYLE_TAG", () => {
  const c = loadConfig(baseEnv({ ...EL, ELEVENLABS_VOICE_ID: V_DEF, ELEVENLABS_VOICE_IDS: `ar=${V_AR},en=${V_EN}`, ELEVENLABS_MODEL_IDS: "ar=eleven_v3", VOICE_STYLE_TAG: "warm", VOICE_STYLE_TAGS: "en=calm" }));
  assert.deepEqual(elevenLabsVoiceFor(c, "ar"), { voiceId: V_AR, modelId: "eleven_v3", styleTag: "[warm]", voiceFrom: "language" });
  assert.deepEqual(elevenLabsVoiceFor(c, "en"), { voiceId: V_EN, modelId: "eleven_v4", styleTag: "[calm]", voiceFrom: "language" });
  assert.deepEqual(elevenLabsVoiceFor(c, "de"), { voiceId: V_DEF, modelId: "eleven_v4", styleTag: "[warm]", voiceFrom: "default" });
  const only = loadConfig(baseEnv({ ...EL, ELEVENLABS_VOICE_IDS: `ar=${V_AR}` }));
  assert.equal(elevenLabsVoiceFor(only, "en").voiceFrom, "none");
});

test("routing: all languages to ElevenLabs by default; a Workers AI language with no ElevenLabs voice stays on Workers AI", () => {
  const all = loadConfig(baseEnv({ ...EL, ELEVENLABS_VOICE_ID: V_DEF }));
  for (const l of ["ar", "en", "fr", "es", "zh", "ja", "ko", "de", "tr"]) assert.equal(ttsProviderFor(all, l), "elevenlabs", l);
  assert.equal(ttsProviderFor(all, "english"), null, "not a two-letter code: no voice");
  const arOnly = loadConfig(baseEnv({ ...EL, ELEVENLABS_VOICE_IDS: `ar=${V_AR}` }));
  assert.equal(ttsProviderFor(arOnly, "ar"), "elevenlabs");
  assert.equal(ttsProviderFor(arOnly, "en"), "workers-ai", "no English voice anywhere: Workers AI keeps it");
  assert.equal(ttsProviderFor(arOnly, "de"), "elevenlabs", "no Workers AI voice either: ElevenLabs answers voice_missing (text sent)");
  assert.deepEqual(voiceLanguagesOf(arOnly), ["ar", "en", "fr", "es", "zh", "ja", "ko", "*"]);
  const split = loadConfig(baseEnv({ ...EL, ELEVENLABS_VOICE_ID: V_DEF, VOICE_REPLY_ROUTING: "non-workers-ai" }));
  assert.equal(ttsProviderFor(split, "en"), "workers-ai");
  assert.equal(ttsProviderFor(split, "ar"), "elevenlabs");
  assert.deepEqual(voiceRoutingOf(split), {
    routing: "non-workers-ai", other_languages: "elevenlabs",
    provider_by_language: { ar: "elevenlabs", en: "workers-ai", fr: "workers-ai", es: "workers-ai", zh: "workers-ai", ja: "workers-ai", ko: "workers-ai" },
  });
  assert.deepEqual(voiceRoutingOf(loadConfig(baseEnv())), {
    routing: "all", other_languages: "none",
    provider_by_language: { ar: "none", en: "workers-ai", fr: "workers-ai", es: "workers-ai", zh: "workers-ai", ja: "workers-ai", ko: "workers-ai" },
  });
});

test("synthesize: English and Arabic each go to ElevenLabs with their own voice; French with the fallback voice; model and tag per language", async () => {
  const { h, el, workers } = harness({ ELEVENLABS_VOICE_ID: V_DEF, ELEVENLABS_VOICE_IDS: `ar=${V_AR},en=${V_EN}`, ELEVENLABS_MODEL_IDS: "ar=eleven_v3", VOICE_STYLE_TAGS: "ar=[warm]" });
  const ar = await synthesize(h.ctx, AR, "ar");
  const en = await synthesize(h.ctx, EN, "en");
  const fr = await synthesize(h.ctx, "Votre rendez-vous est confirmé.", "fr");
  assert.equal(workers.length, 0, "Workers AI not used for any language");
  assert.deepEqual(el.map((c) => c.voice), [V_AR, V_EN, V_DEF]);
  assert.deepEqual(el[0]!.body, { text: `[warm] ${AR}`, model_id: "eleven_v3" });
  assert.deepEqual(el[1]!.body, { text: EN, model_id: "eleven_v4" });
  assert.ok(ar.ok && en.ok && fr.ok);
  if (ar.ok && en.ok && fr.ok) {
    assert.deepEqual([ar.voiceFrom, en.voiceFrom, fr.voiceFrom], ["language", "language", "default"]);
    assert.equal(en.chars, EN.length);
    assert.equal(ar.chars, `[warm] ${AR}`.length, "the tag is part of what ElevenLabs bills");
  }
  assert.ok(!JSON.stringify(h.logs).includes(KEY), "the key is never logged");
});

test("bad per-language config: entries skipped with a voice_map_ignored log line; the reply still speaks with the fallback voice", async () => {
  const { h, el } = harness({ ELEVENLABS_VOICE_ID: V_DEF, ELEVENLABS_VOICE_IDS: "en=not a voice!,{oops", ELEVENLABS_MODEL_IDS: "{broken" });
  const r = await synthesize(h.ctx, EN, "en");
  assert.equal(r.ok, true);
  assert.deepEqual(el.map((c) => c.voice), [V_DEF]);
  const line = h.logs.find((l) => l.event === "voice_map_ignored");
  assert.deepEqual(line?.fields, { voice_ids: 2, model_ids: 1, style_tags: 0 });
  assert.ok(!JSON.stringify(h.logs).includes("not a voice"), "the bad value itself is not logged");
  const ov: any = await getOverview(h.ctx, null);
  assert.deepEqual(ov.media.elevenlabs.ignored_entries, { voice_ids: 2, model_ids: 1, style_tags: 0 });
  // no voice at all for a language Workers AI lacks: the text goes instead, no ElevenLabs call
  const n = harness({ ELEVENLABS_VOICE_IDS: `ar=${V_AR}` });
  const d = await synthesize(n.h.ctx, "Ihr Termin ist bestätigt.", "de");
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "voice_tts_el_voice_missing");
  assert.equal(n.el.length, 0);
});

test("send_reply end to end: an English reply to a voice note goes out as an ElevenLabs voice note with the English voice", async () => {
  const { h, el, workers } = harness({ ELEVENLABS_VOICE_ID: V_DEF, ELEVENLABS_VOICE_IDS: `ar=${V_AR},en=${V_EN}` });
  await activate(h);
  await post(h, inboundPayload({ wamid: "wamid.R1", type: "audio", extra: { audio: { id: "M1", mime_type: "audio/ogg; codecs=opus", voice: true } } }));
  const c: any = await claimConversation(h.ctx, cid());
  await getHistory(h.ctx, cid(), c.lease);
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text: EN, voice_language: "en" });
  assert.equal(r.sent_as, "voice");
  assert.deepEqual(el.map((x) => x.voice), [V_EN]);
  assert.equal(workers.length, 0);
  const ov: any = await getOverview(h.ctx, null);
  assert.deepEqual(ov.media.elevenlabs.voices, { ar: V_AR, en: V_EN, "*": V_DEF });
  assert.equal(ov.media.voice_routing.provider_by_language.en, "elevenlabs");
  assert.equal(ov.media.today.voice_el_sent, 1);
  assert.ok(!JSON.stringify(ov).includes(KEY), "ids only, never the key");
});

test("gender-neutral address: every Arabic preset, the text-reply guidance and the default call persona", async () => {
  for (const d of ["msa", "lebanese", "gulf", "egyptian"] as const) {
    const s = spokenStyle(d)!;
    assert.ok(/plural/.test(s) && /never a masculine or feminine singular/.test(s), d);
  }
  assert.ok(DIALECT_STYLES.lebanese.includes("إنتو") && DIALECT_STYLES.lebanese.includes("فيكن"));
  assert.ok(!/أهلا فيك،|بدّك،|يمكنك → فيك/.test(DIALECT_STYLES.lebanese), "no singular examples left");
  assert.ok(!/شلونك،|تقدر،/.test(DIALECT_STYLES.gulf) && !/إزيك،|عايز،/.test(DIALECT_STYLES.egyptian));
  assert.ok(/without assuming their gender/.test(NEUTRAL_ADDRESS));
  const cfg = loadConfig(baseEnv({ CALL_BUSINESS_NAME: "Example Co" }));
  assert.ok(buildInstructions(cfg).includes("Address the caller without assuming their gender"));
  assert.equal(buildInstructions(loadConfig(baseEnv({ CALL_INSTRUCTIONS: "Only this." }))), "Only this.", "owner-written instructions are kept as written");
  const h = makeHarness();
  const route = createMcpRoute(() => h.ctx);
  const res = await route(new Request("https://x.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }));
  const t = await res.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  const j = JSON.parse(line ? line.slice(5) : t);
  const send = j.result.tools.find((x: any) => x.name === "send_reply");
  assert.ok(send.description.includes(NEUTRAL_ADDRESS), "text replies get the same guidance");
});
