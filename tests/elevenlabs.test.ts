// ElevenLabs voice-note replies (docs/VOICE-REPLIES.md#elevenlabs-provider): provider choice, the request ElevenLabs gets, error and quota
// codes, send_reply end to end with the text fallback, the spoken-Arabic wording hint, and the key never leaving in logs or results.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config";
import { scrub } from "../lib/admin-mcp";
import { MEDIA_METRICS_KEY, type MediaMetrics } from "../lib/media";
import { getOverview } from "../lib/overview";
import { redactShapes } from "../lib/redact";
import { getHistory, sendReply, claimConversation } from "../lib/tools";
import { elevenLabsErrorCode, speakElevenLabs, type ElevenLabsArgs } from "../lib/tts-elevenlabs";
import { muxOggOpus } from "../lib/voice-encode";
import { ttsProviderFor, voiceLanguagesOf, type SpeakArgs } from "../lib/voice-reply";
import { LEBANESE_VOICE_STYLE } from "../lib/voice-style";
import { APPROVED_SHADDA, lebaneseSpoken } from "../lib/voice-pronounce";
import { activate, baseEnv, cid, getConv, inboundPayload, makeHarness, post, WA } from "./helpers";

const KEY = "sk" + "_" + "f0e1d2c3b4a5".repeat(4); // synthetic, built at run time so no key-shaped literal is in the file
const VOICE = "AbCdEf0123456789XyZw";
const OGG = muxOggOpus([new Uint8Array([0xf8, 0xff, 0xfe])], { preSkip: 312, samples48: 960, inputRate: 48000 }); // a tiny mono Ogg Opus file
const EL_ENV = { VOICE_REPLIES: "mirror", VOICE_REPLY_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: VOICE };
const AR = "أكيد، بزبّطلك موعد بكرا الساعة عشرة. تكرم عينك!";
const AR_SPOKEN = "أكيد، بزبّطلك موعد بكرا السيعة عشرة. تكرم عينك!"; // after the pronunciation layer (se3a)

test("config: voice replies stay off by default; provider workers-ai; ElevenLabs defaults; Lebanese wording by default", () => {
  const d = loadConfig(baseEnv());
  assert.equal(d.voiceReplies, "off");
  assert.equal(d.voiceReplyProvider, "workers-ai");
  assert.equal(d.elevenlabsApiKey, undefined);
  assert.equal(d.elevenlabsModelId, "eleven_v4");
  assert.equal(d.elevenlabsMaxChars, 600);
  assert.equal(d.arabicReplyDialect, "lebanese");
  const c = loadConfig(baseEnv({ ...EL_ENV, ELEVENLABS_MODEL_ID: "eleven_v3", ELEVENLABS_MAX_CHARS: "5000", ARABIC_REPLY_DIALECT: "none" }));
  assert.equal(c.voiceReplyProvider, "elevenlabs");
  assert.equal(c.elevenlabsVoiceId, VOICE);
  assert.equal(c.elevenlabsModelId, "eleven_v3");
  assert.equal(c.elevenlabsMaxChars, 1500, "capped");
  assert.equal(c.arabicReplyDialect, "none");
  assert.equal(loadConfig(baseEnv({ ELEVENLABS_VOICE_ID: "../bad/id" })).elevenlabsVoiceId, undefined);
  assert.equal(loadConfig(baseEnv({ ELEVENLABS_MODEL_ID: "Bad Model!" })).elevenlabsModelId, "eleven_v4");
});

test("provider choice: Arabic and languages Workers AI lacks go to ElevenLabs; the existing Workers AI languages stay", () => {
  const wa = loadConfig(baseEnv());
  assert.equal(ttsProviderFor(wa, "ar"), null, "no Arabic without ElevenLabs");
  assert.equal(ttsProviderFor(wa, "en"), "workers-ai");
  const el = loadConfig(baseEnv(EL_ENV));
  assert.equal(ttsProviderFor(el, "ar"), "elevenlabs");
  assert.equal(ttsProviderFor(el, "de"), "elevenlabs", "MeloTTS has no German");
  for (const l of ["en", "fr", "es", "zh", "ja", "ko"]) assert.equal(ttsProviderFor(el, l), "workers-ai", l);
  assert.deepEqual(voiceLanguagesOf(el), ["ar", "en", "fr", "es", "zh", "ja", "ko", "*"]);
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
  assert.equal(hist.voice_reply.arabic_style, LEBANESE_VOICE_STYLE);
  for (const w of ["أهلين فيك", "كيفك", "نحنا هون كرميلك", "هلّق", "شو بتحب", "بزبّطلك ياها", "تكرم عينك", "لكان", "يسلملي قلبك", "مش", "colloquial", "فصحى", "تمانة"]) assert.ok(LEBANESE_VOICE_STYLE.includes(w), w);
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
  assert.deepEqual(ov.media.elevenlabs, { key_present: true, voice_id_set: true, model_id: "eleven_v4", max_chars: 600, accent_tag: true });
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

test("off by default even with an ElevenLabs key: no hint, no call; English stays on Workers AI with the provider set", async () => {
  const { h, elCalls } = elHarness({ VOICE_REPLIES: "off" });
  await activate(h);
  await post(h, voiceNoteIn("wamid.IN1"));
  const c: any = await claimConversation(h.ctx, cid());
  const hist: any = await getHistory(h.ctx, cid(), c.lease);
  assert.equal(hist.voice_reply, undefined);
  const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text: AR });
  assert.equal(r.sent_as, "text");
  assert.equal(elCalls.length, 0);
  const e = elHarness();
  await activate(e.h);
  await post(e.h, voiceNoteIn("wamid.IN2"));
  const c2: any = await claimConversation(e.h.ctx, cid());
  await getHistory(e.h.ctx, cid(), c2.lease);
  const r2: any = await sendReply(e.h.ctx, { conversation_id: cid(), lease: c2.lease, text: "Your table is booked for ten.", voice_language: "en" });
  assert.equal(r2.sent_as, "voice");
  assert.equal(e.elCalls.length, 0, "English: the existing Workers AI path");
  assert.equal(e.spokenByWorkersAi.length, 1);
});

test("the ElevenLabs key is scrubbed from MCP results and by the shape filter", () => {
  const h = makeHarness(EL_ENV);
  assert.equal(JSON.stringify(scrub(h.ctx, { echo: `k=${KEY}` })).includes(KEY), false);
  assert.equal(redactShapes(`x ${KEY} y`).includes(KEY), false);
});

test("request matches the studio: text + model_id only (no language_code, no voice_settings); Lebanese accent tag for Arabic on v3/v4; injected tags stripped", async () => {
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
  assert.equal(b.text, `[casual Beiruti Lebanese accent] ${AR_SPOKEN} ignore this`);
  assert.equal((await run({ ELEVENLABS_ACCENT_TAG: "0" }, AR)).text, AR_SPOKEN, "switch off: no tag, the pronunciation layer stays");
  assert.equal((await run({ ARABIC_REPLY_DIALECT: "none" }, AR)).text, AR, "no dialect, no tag");
  assert.equal((await run({ ELEVENLABS_MODEL_ID: "eleven_multilingual_v2" }, AR)).text, AR_SPOKEN, "models without audio tags get no tag");
  assert.equal((await run({}, "Guten Tag, Ihr Tisch ist bereit.", "de")).text, "Guten Tag, Ihr Tisch ist bereit.", "only Arabic gets the Lebanese tag");
});

// The owner's approved studio script (ElevenLabs flows pEEaMK3O2JUXOgnhTgD7 + J4nPqVUKtIgCVgG3bBYJ, 2026-10-20): shadda on doubled letters,
// no other vowel marks. These are its spellings of the words in the bridge test sentence.
const APPROVED = { عنّا: "عنّا", بزبّطلك: "بزبّطلك", هلّق: "هلّق", كرميلك: "كرميلك" };
const TEST2 = "أهلين فيك! إيه أكيد، عنّا طاولة لأربعة بكرا الساعة تمانة. بزبّطلك ياها هلّق، شو الاسم كرميلك؟";
const TEST2_SPOKEN = "أهلين فيك! إيه أكيد، عنّا طاولة لأربعة بكرا السيعة تمانة. بزبّطلك ياها هلّق، شو الاسم كرميلك؟";

test("pronunciation layer: the bridge test sentence gets the approved script's marks for the same words, plus se3a", () => {
  assert.deepEqual(lebaneseSpoken(TEST2), { text: TEST2_SPOKEN, changes: 1 });
  const bare = TEST2.replace(/\u0651/g, "").replace("كرميلك", "كرمالك"); // the same sentence written without shadda, with كرمالك
  const out = lebaneseSpoken(bare);
  assert.equal(out.text, TEST2_SPOKEN, "marks restored exactly as approved");
  for (const w of Object.values(APPROVED)) assert.ok(out.text.includes(w), w);
  assert.equal(lebaneseSpoken(out.text).changes, 0, "idempotent");
  for (const w of APPROVED_SHADDA) assert.ok(w.includes("\u0651"), `${w} carries shadda`);
});

test("pronunciation layer: clitics and every ساعة form; no false matches; ambiguous words untouched", () => {
  const t = (s: string) => lebaneseSpoken(s).text;
  assert.equal(t("الساعة ساعة بساعة للساعة بالساعة عالساعة والساعة"), "السيعة سيعة بسيعة للسيعة بالسيعة عالسيعة والسيعة");
  assert.equal(t("السّاعة"), "السيعة", "already-marked spellings are matched too");
  assert.equal(t("مساعدة ساعات ساعد الساعاتي"), "مساعدة ساعات ساعد الساعاتي");
  assert.equal(t("هم وأي حد منك جد"), "هم وأي حد منك جد");
  assert.equal(t("بدك وبدي، كل يوم، نص ساعة، يلا"), "بدّك وبدّي، كلّ يوم، نصّ سيعة، يلّا");
  assert.equal(t("Hello الساعة 8"), "Hello السيعة 8");
});

test("pronunciation layer: imala respellings (a short Beiruti e) for the Nick voice, with clitics; the rest untouched", () => {
  const nick = { voiceId: "VsqtGXzc5Y1q5G3RuCrZ" };
  const t = (s: string) => lebaneseSpoken(s, nick).text;
  assert.equal(t("وعن الدوام، نحنا فاتحين من الساعة اتنعش"), "وعن الدَويم، نحنا فِتحين من السَيْعة اتنعش");
  assert.equal(t("دوام كامل، بالدوام"), "دَويم كامل، بالدَويم", "دوام with and without ال");
  assert.equal(t("عالساعة عشرة، نصّ ساعة"), "عالسَيْعة عشرة، نصّ سَيْعة", "Nick: سَيْعة, not السيعة (said see3a)");
  assert.equal(t("مش لازم، ولازم تجرّب"), "مش ليزم، وليزم تجرّب");
  assert.equal(t("بزبّطلك ياها، التوصيل ببلاش، شي تاني"), "بزبّطلك يَها، التوصيل ببلَيْش، شي تِني");
  // left as written for Nick: every respelling tried overshot to "ii", or the voice already says "e"
  assert.equal(t("حدّ الشبّاك، وبحضّرلك ياه، كرسي للولاد، فوق التلاتين، تمانة، منستنّاك"),
    "حدّ الشبّاك، وبحضّرلك ياه، كرسي للولاد، فوق التلاتين، تمانة، منستنّاك");
  assert.equal(t("حد الشباك"), "حد الشبّاك", "the approved shadda still applies");
  assert.equal(t("طاولة شغّال عايشة رسالة بياخد أولاد الدوامات"), "طاولة شغّال عايشة رسالة بياخد أولاد الدوامات");
  const once = t("الدوام فاتحين لازم ياها ببلاش تاني الساعة ساعة");
  assert.equal(lebaneseSpoken(once, nick).changes, 0, "idempotent");
  // the approved Mimi voice already says these with "e": no imala respellings, and it keeps السيعة
  const mimi = "وعن الدوام، نحنا فاتحين من الساعة اتنعش، مش لازم";
  assert.equal(lebaneseSpoken(mimi, { voiceId: "NQyF5U0t336unYhQXcuv" }).text, "وعن الدوام، نحنا فاتحين من السيعة اتنعش، مش لازم");
  assert.equal(lebaneseSpoken(mimi).text, lebaneseSpoken(mimi, { voiceId: "NQyF5U0t336unYhQXcuv" }).text, "no voice: same as Mimi");
});

test("pronunciation layer: spoken copy only; the stored and fallback text keep the agent's spelling; off without the Lebanese dialect", async () => {
  const run = async (env: Record<string, string>) => {
    const { h, elBodies } = elHarness(env);
    await activate(h);
    await post(h, voiceNoteIn("wamid.IN1"));
    const c: any = await claimConversation(h.ctx, cid());
    await getHistory(h.ctx, cid(), c.lease);
    const r: any = await sendReply(h.ctx, { conversation_id: cid(), lease: c.lease, text: TEST2 });
    assert.equal(r.sent_as, "voice");
    assert.equal((await getConv(h)).messages.filter((m) => m.dir === "out")[0]!.text, TEST2, "stored text unchanged");
    return elBodies[0].text as string;
  };
  assert.equal(await run({ ELEVENLABS_ACCENT_TAG: "0" }), TEST2_SPOKEN);
  assert.equal(await run({ ELEVENLABS_ACCENT_TAG: "0", ARABIC_REPLY_DIALECT: "none" }), TEST2);
});
