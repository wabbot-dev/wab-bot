#!/usr/bin/env bash
# Rebuilds lib/wasm/voice-opus.wasm (the voice-note encoder, docs/VOICE-REPLIES.md) from pinned, checksummed sources:
#   libopus 1.5.2 (BSD-3-Clause), speexdsp 1.2.1 resampler (BSD-3-Clause), minimp3 (CC0-1.0), wasi-sdk 25 (Apache-2.0 WITH LLVM-exception;
#   its libc is MIT / public domain). Only needed when changing native/voice-opus/voice.c; the built .wasm is committed.
#   bash scripts/build-voice-wasm.sh            (Linux x86_64; downloads about 130 MB into a temporary directory)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
cd "$W"
fetch() { curl -fsSL -o "$2" "$1"; echo "$3  $2" | sha256sum -c --quiet -; }
fetch https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz wasi-sdk.tgz 52640dde13599bf127a95499e61d6d640256119456d1af8897ab6725bcf3d89c
fetch https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz opus.tgz 65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
fetch https://downloads.xiph.org/releases/speex/speexdsp-1.2.1.tar.gz speexdsp.tgz 8c777343e4a6399569c72abc38a95b24db56882c83dbdb6c6424a5f4aeb54d3d
fetch https://raw.githubusercontent.com/lieff/minimp3/ea99364f61c14656440e8d77e9c233ccf3124633/minimp3.h minimp3.h 57e437c5c1f0e8b243885d3929c8973b5e6c778451e0100ab4251d19915cb3ad
for f in wasi-sdk.tgz opus.tgz speexdsp.tgz; do tar xzf "$f"; done
S=wasi-sdk-25.0-x86_64-linux; O=opus-1.5.2
# float build, encoder sources only are kept by the linker (--gc-sections); same lists as libopus' own Makefile
SRCS=$(python3 - <<'PY'
import re
o="opus-1.5.2/"
def get(f, var):
    s=open(o+f).read(); m=re.search(var+r" = \\\n((?:.*\\\n)*.*\n)", s)
    return [x.strip(" \\") for x in m.group(1).split("\n") if x.strip(" \\")]
print(" ".join(o+x for x in get("celt_sources.mk","CELT_SOURCES")+get("silk_sources.mk","SILK_SOURCES")+get("silk_sources.mk","SILK_SOURCES_FLOAT")+get("opus_sources.mk","OPUS_SOURCES")+get("opus_sources.mk","OPUS_SOURCES_FLOAT")))
PY
)
cp "$ROOT/native/voice-opus/voice.c" .
# shellcheck disable=SC2086
"$S/bin/clang" --sysroot="$S/share/wasi-sysroot" --target=wasm32-wasi -O3 -flto -msimd128 \
  -DOPUS_BUILD -DUSE_ALLOCA -DHAVE_LRINTF -DHAVE_LRINT -DFLOATING_POINT -DOUTSIDE_SPEEX -DRANDOM_PREFIX=vn -DEXPORT= \
  -I$O/include -I$O/celt -I$O/silk -I$O/silk/float -I$O -I. -Ispeexdsp-1.2.1/include/speex -Ispeexdsp-1.2.1/include \
  -nostartfiles -mexec-model=reactor -Wl,--no-entry -Wl,--strip-all -Wl,--gc-sections \
  -o "$ROOT/lib/wasm/voice-opus.wasm" voice.c speexdsp-1.2.1/libspeexdsp/resample.c $SRCS -lm
echo "built lib/wasm/voice-opus.wasm ($(wc -c < "$ROOT/lib/wasm/voice-opus.wasm") bytes)"
