// The voice-note encoder module (docs/VOICE-REPLIES.md). Wrangler bundles a .wasm import as a pre-compiled WebAssembly.Module:
// Workers cannot compile WebAssembly from bytes at run time.
import voiceWasm from "../lib/wasm/voice-opus.wasm";
import { encodeVoiceNote, VoiceEncodeError } from "../lib/voice-encode";
import type { VoiceEncoder } from "../lib/voice-reply";

export const encodeInIsolate: VoiceEncoder = async (input, opts) => {
  try {
    const r = await encodeVoiceNote(voiceWasm, input, { maxSeconds: opts.maxSeconds });
    return { ok: true, ogg: r.ogg, seconds: r.seconds };
  } catch (e) {
    return { ok: false, code: e instanceof VoiceEncodeError ? e.code : "encode_failed" };
  }
};
