/**
 * In-Worker voice-note encoder: MP3 (or 16-bit PCM WAV) in, Ogg Opus out (mono, 16 kHz, 20 ms frames), the format
 * WhatsApp shows as a voice-note bubble. The heavy lifting is a small WebAssembly module (lib/wasm/voice-opus.wasm,
 * built by scripts/build-voice-wasm.sh from libopus, the speexdsp resampler and minimp3; complexity 0 by default, the cheapest
 * setting, about 6 ms of CPU per second of audio); this file only drives it and
 * writes the Ogg container (RFC 7845). The module is passed in pre-compiled, because Workers cannot compile WebAssembly
 * from bytes at run time.
 */

export interface EncodedVoice {
  ogg: Uint8Array;
  seconds: number;
  packets: number;
}

export class VoiceEncodeError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const ERRORS: Record<number, string> = {
  [-1]: "encode_out_of_memory",
  [-2]: "encode_mixed_sample_rates",
  [-3]: "encode_too_long",
  [-4]: "encode_no_audio",
  [-5]: "encode_unknown_format",
  [-6]: "encode_unsupported_wav",
  [-7]: "encode_bad_sample_rate",
  [-8]: "encode_resampler",
  [-9]: "encode_opus_init",
  [-10]: "encode_output_full",
  [-11]: "encode_opus",
};

interface VoiceExports {
  memory: WebAssembly.Memory;
  vn_alloc(n: number): number;
  vn_free(p: number): void;
  vn_encode(inPtr: number, inLen: number, maxSeconds: number, bitrate: number, complexity: number, out: number, outCap: number, outLen: number, samples48: number): number;
}

const imports = {
  // libc asks for entropy once (hash seeds); nothing here is security-relevant, so zeros are fine.
  wasi_snapshot_preview1: { random_get: (_p: number, _n: number) => 0 },
};

/** A fresh instance per call: the module keeps no state between encodes and memory is released with the instance. */
export async function encodeVoiceNote(mod: WebAssembly.Module, input: Uint8Array, opts: { maxSeconds: number; bitrate?: number; complexity?: number }): Promise<EncodedVoice> {
  const inst = await WebAssembly.instantiate(mod, imports);
  const x = inst.exports as unknown as VoiceExports;
  const outCap = Math.max(64 * 1024, Math.ceil(opts.maxSeconds * 50 * 160) + 4096);
  const inPtr = x.vn_alloc(input.length);
  const outPtr = x.vn_alloc(outCap);
  const meta = x.vn_alloc(8);
  if (!inPtr || !outPtr || !meta) throw new VoiceEncodeError("encode_out_of_memory");
  new Uint8Array(x.memory.buffer, inPtr, input.length).set(input);
  const r = x.vn_encode(inPtr, input.length, Math.floor(opts.maxSeconds), opts.bitrate ?? 24000, opts.complexity ?? 0, outPtr, outCap, meta, meta + 4);
  if (r < 0) throw new VoiceEncodeError(ERRORS[r] ?? "encode_failed");
  const packets = r & 0xfffff;
  const preSkip = r >>> 20;
  const dv = new DataView(x.memory.buffer);
  const used = dv.getInt32(meta, true);
  const samples48 = dv.getInt32(meta + 4, true);
  const raw = new Uint8Array(x.memory.buffer, outPtr, used).slice();
  const list: Uint8Array[] = [];
  for (let p = 0; p < raw.length; ) {
    const n = raw[p] | (raw[p + 1] << 8);
    list.push(raw.subarray(p + 2, p + 2 + n));
    p += 2 + n;
  }
  if (list.length !== packets) throw new VoiceEncodeError("encode_failed");
  return { ogg: muxOggOpus(list, { preSkip, samples48, inputRate: 16000 }), seconds: samples48 / 48000, packets };
}

// ---------------------------------------------------------------- Ogg (RFC 3533) + Opus mapping (RFC 7845)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function crc(b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ b[i]) & 255]) >>> 0;
  return c;
}

function page(serial: number, seq: number, granule: number, flags: number, packets: Uint8Array[]): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const body = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  out[5] = flags;
  dv.setUint32(6, granule >>> 0, true);
  dv.setUint32(10, Math.floor(granule / 0x100000000), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { out.set(p, o); o += p.length; }
  dv.setUint32(22, crc(out), true);
  return out;
}

export function muxOggOpus(packets: Uint8Array[], o: { preSkip: number; samples48: number; inputRate: number; serial?: number }): Uint8Array {
  const serial = o.serial ?? 0x5741_4256;
  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  head[8] = 1; // version
  head[9] = 1; // mono
  hv.setUint16(10, o.preSkip, true);
  hv.setUint32(12, o.inputRate, true);
  const vendor = new TextEncoder().encode("wab-bot");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages: Uint8Array[] = [page(serial, 0, 0, 0x02, [head]), page(serial, 1, 0, 0, [tags])];
  const end = o.preSkip + o.samples48; // last granule = pre-skip + real samples (end trimming)
  let seq = 2;
  let granule = 0;
  const per = 50; // 50 packets (1 s) per page keeps pages well under the 255-segment limit
  for (let i = 0; i < packets.length; i += per) {
    const chunk = packets.slice(i, i + per);
    granule += chunk.length * 960;
    const last = i + per >= packets.length;
    pages.push(page(serial, seq++, last ? Math.min(granule, end) : granule, last ? 0x04 : 0, chunk));
  }
  const total = pages.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pages) { out.set(p, off); off += p.length; }
  return out;
}
