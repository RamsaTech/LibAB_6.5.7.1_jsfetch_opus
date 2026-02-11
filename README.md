# LibAB 6.5.7.1 — h264-aac-mp3 WASM Build

Custom [libav.js](https://github.com/nicholasnooney/libav.js) WASM build for the EYTD web extension. Produces a single `.wasm.mjs` + `.wasm` pair with jsfetch protocol support for HLS streaming.

## What's Included

| Component | Version | Purpose |
|-----------|---------|---------|
| FFmpeg | 7.1 | Core multimedia framework |
| emfiberthreads | 1.1 | Async fiber support for Emscripten |
| lame | 3.100 | MP3 encoding (libmp3lame) |
| libvpx | 1.15.0 | VP9 decoding |
| openh264 | 2.5.0 | H.264 support |

### Enabled Capabilities

- **Protocols:** data, file, jsfetch, crypto
- **Demuxers:** matroska, aac, hls, flv, dash, mpegts, mp3, mov, webvtt, srt, ass, ogg
- **Muxers:** mp4, matroska, hls, mp3
- **Decoders:** aac, h264, mp3, libvpx_vp9
- **Encoders:** libmp3lame
- **Filters:** aresample, asetnsamples
- **BSFs:** h264_metadata, extract_extradata, vp9_metadata, opus_metadata
- **Tools:** ffmpeg, ffprobe (via Module interface)

## Building

### Prerequisites

- [Emscripten SDK](https://emscripten.org/) 3.1.71
- Node.js 20+
- pkg-config

### Local Build

```bash
# Activate emsdk first
source /path/to/emsdk/emsdk_env.sh

# Run the build
./scripts/build.sh
```

Output appears in `dist/`:
- `libav-6.5.7.1-h264-aac-mp3.wasm.mjs` — ES6 module (JS glue + WASM loader)
- `libav-6.5.7.1-h264-aac-mp3.wasm.wasm` — WebAssembly binary

### CI Build

Push to `main` or open a PR to trigger the GitHub Actions workflow. Build artifacts are uploaded automatically.

## Project Structure

```
patches/ffmpeg/     10 FFmpeg patches (series7) including jsfetch protocol
patches/            openh264 compatibility patch
src/                C bindings, JS glue, function definitions
scripts/build.sh    Main build orchestrator (downloads, builds, links)
scripts/            apply-funcs.js, mk-es6.js helpers
dist/               Build output (gitignored)
```

## Patches

The `patches/ffmpeg/series7` file defines the patch order for FFmpeg 7.x:

1. `01-blocking-reader.diff` — Blocking reader for async I/O
2. `02-openh264-api.diff` — OpenH264 API compatibility
3. `03-opus-flt.diff` — Opus float format support
4. `04-ogg-no-crc.diff` — Skip OGG CRC checks
5. `05-fibers.diff` — Emfiberthreads integration
6. `06-doxygen-xml.diff` — Doxygen XML output support
7. `07-jsfetch-protocol.diff` — JavaScript fetch protocol for HLS
8. `08-fftools.diff` — FFmpeg CLI tools for Emscripten
9. `09-no-file.diff` — Disable file-based features
10. `10-write-malloc-crash.diff` — Fix write/malloc crash
