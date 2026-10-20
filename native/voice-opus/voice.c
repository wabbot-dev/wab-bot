/* Tiny WebAssembly voice-note encoder: MP3 or 16-bit PCM WAV in, Opus packets out (mono, 16 kHz, 20 ms frames).
   minimp3 (CC0) decodes, the speexdsp resampler (BSD-3-Clause) resamples, libopus (BSD-3-Clause) encodes. The caller muxes Ogg. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#define MINIMP3_IMPLEMENTATION
#define MINIMP3_NO_SIMD
#include "minimp3.h"
#include "speex_resampler.h"
#include "opus.h"

#define OUT_RATE 16000
#define FRAME 320 /* 20 ms at 16 kHz */

__attribute__((export_name("vn_alloc"))) void *vn_alloc(int n) { return malloc((size_t)n); }
__attribute__((export_name("vn_free"))) void vn_free(void *p) { free(p); }

static int16_t *pcm = 0; static int pcm_len = 0, pcm_cap = 0, in_rate = 0;
static int push(const int16_t *s, int n, int ch) {
  if (pcm_len + n > pcm_cap) {
    int cap = pcm_cap ? pcm_cap * 2 : 1 << 18; while (cap < pcm_len + n) cap *= 2;
    int16_t *p = realloc(pcm, (size_t)cap * 2); if (!p) return -1; pcm = p; pcm_cap = cap;
  }
  for (int i = 0; i < n; i++) {
    if (ch == 2) pcm[pcm_len + i] = (int16_t)(((int)s[2 * i] + (int)s[2 * i + 1]) / 2);
    else pcm[pcm_len + i] = s[i];
  }
  pcm_len += n; return 0;
}

static int decode_mp3(const uint8_t *buf, int len, int max_samples) {
  static mp3dec_t dec; mp3dec_frame_info_t info; int16_t frame[MINIMP3_MAX_SAMPLES_PER_FRAME];
  mp3dec_init(&dec);
  while (len > 0) {
    int n = mp3dec_decode_frame(&dec, buf, len, frame, &info);
    if (info.frame_bytes == 0) break;
    buf += info.frame_bytes; len -= info.frame_bytes;
    if (n > 0) {
      if (!in_rate) in_rate = info.hz;
      if (info.hz != in_rate) return -2;
      if (push(frame, n, info.channels) < 0) return -1;
      if (pcm_len > max_samples) return -3;
    }
  }
  return pcm_len > 0 ? 0 : -4;
}

static uint32_t rd32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }
static int decode_wav(const uint8_t *buf, int len, int max_samples) {
  if (len < 12 || memcmp(buf, "RIFF", 4) || memcmp(buf + 8, "WAVE", 4)) return -5;
  int pos = 12, ch = 0, bits = 0;
  while (pos + 8 <= len) {
    uint32_t sz = rd32(buf + pos + 4); const uint8_t *d = buf + pos + 8;
    if (!memcmp(buf + pos, "fmt ", 4) && sz >= 16) { ch = d[2] | d[3] << 8; in_rate = (int)rd32(d + 4); bits = d[14] | d[15] << 8; }
    else if (!memcmp(buf + pos, "data", 4)) {
      if (bits != 16 || (ch != 1 && ch != 2)) return -6;
      if (sz > (uint32_t)(len - pos - 8) || sz == 0xFFFFFFFFu) sz = (uint32_t)(len - pos - 8);
      int n = (int)(sz / (2u * ch)); if (n > max_samples) return -3;
      return push((const int16_t *)d, n, ch) < 0 ? -1 : (n > 0 ? 0 : -4);
    }
    pos += 8 + (int)sz + (sz & 1);
  }
  return -5;
}

/* Returns the number of Opus packets written to out as [u16 little-endian length][bytes]..., or a negative error.
   *out_len receives the bytes used; *samples48 the decoded length in 48 kHz samples (for the Ogg granule). */
__attribute__((export_name("vn_encode")))
int vn_encode(const uint8_t *in, int in_len, int max_seconds, int bitrate, int complexity, uint8_t *out, int out_cap, int *out_len, int *samples48) {
  pcm_len = 0; in_rate = 0;
  int r = (in_len >= 4 && !memcmp(in, "RIFF", 4)) ? decode_wav(in, in_len, 48000 * max_seconds) : decode_mp3(in, in_len, 48000 * max_seconds);
  if (r < 0) return r;
  if (in_rate < 8000 || in_rate > 48000) return -7;
  if (pcm_len > in_rate * max_seconds) return -3;
  /* resample to 16 kHz */
  int n16 = (int)((int64_t)pcm_len * OUT_RATE / in_rate) + FRAME;
  int16_t *s16 = malloc((size_t)(n16 + FRAME) * 2); if (!s16) return -1;
  spx_uint32_t got = (spx_uint32_t)n16;
  if (in_rate == OUT_RATE) { memcpy(s16, pcm, (size_t)pcm_len * 2); got = (spx_uint32_t)pcm_len; }
  else {
    int err = 0; SpeexResamplerState *rs = speex_resampler_init(1, (spx_uint32_t)in_rate, OUT_RATE, 3, &err);
    if (!rs) { free(s16); return -8; }
    spx_uint32_t inl = (spx_uint32_t)pcm_len;
    speex_resampler_process_int(rs, 0, pcm, &inl, s16, &got);
    speex_resampler_destroy(rs);
  }
  int frames = ((int)got + FRAME - 1) / FRAME;
  memset(s16 + got, 0, (size_t)(frames * FRAME - (int)got) * 2);
  int err = 0; OpusEncoder *enc = opus_encoder_create(OUT_RATE, 1, OPUS_APPLICATION_VOIP, &err);
  if (!enc) { free(s16); return -9; }
  opus_encoder_ctl(enc, OPUS_SET_BITRATE(bitrate));
  opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(complexity < 0 ? 0 : complexity > 10 ? 10 : complexity));
  opus_encoder_ctl(enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
  int used = 0, packets = 0;
  for (int f = 0; f < frames; f++) {
    if (used + 2 + 1275 > out_cap) { opus_encoder_destroy(enc); free(s16); return -10; }
    int n = opus_encode(enc, s16 + f * FRAME, FRAME, out + used + 2, 1275);
    if (n < 0) { opus_encoder_destroy(enc); free(s16); return -11; }
    out[used] = (uint8_t)(n & 255); out[used + 1] = (uint8_t)(n >> 8); used += 2 + n; packets++;
  }
  opus_int32 lookahead = 0; opus_encoder_ctl(enc, OPUS_GET_LOOKAHEAD(&lookahead));
  opus_encoder_destroy(enc); free(s16);
  free(pcm); pcm = 0; pcm_cap = 0;
  *out_len = used;
  *samples48 = (int)got * 3; /* 16 kHz -> 48 kHz granule units */
  return packets | (lookahead * 3) << 20; /* pre-skip (48 kHz) packed in the high bits */
}
