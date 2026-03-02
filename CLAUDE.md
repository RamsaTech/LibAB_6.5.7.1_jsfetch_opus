# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Custom FFmpeg/libav.js WASM build for the EYTD (Easy YouTube Video Downloader) browser extension. Compiles FFmpeg 8.x with select codecs into a single `.wasm` + `.wasm.mjs` pair, featuring a custom **jsfetch protocol** that enables HLS streaming via the browser Fetch API.

**Output artifact:** `dist/libav-6.8.8.0-h264-aac-mp3.wasm.mjs` + `.wasm`

## Build Commands

```bash
# Full build (downloads dependencies, compiles everything, ~30+ min first run)
./scripts/build.sh

# Build caches completed steps in build/ — delete specific subdirs to rebuild a step
# e.g. rm -rf build/ffmpeg to force FFmpeg rebuild
```

**Prerequisites:** Emscripten SDK 5.0.2, Node.js 20+, pkg-config

There are no tests or linting configured in this repository.

## Architecture

### Build Pipeline (scripts/build.sh)

9-step orchestrator that compiles codec libraries with Emscripten, patches FFmpeg, and links a WASM module:

1. **emfiberthreads** — async fiber support for Emscripten
2. **lame** (libmp3lame) — MP3 encoding
3. **libvpx** — VP9 decoding
4. **openh264** — H.264 decoding
5. **FFmpeg download** + apply patches from `patches/ffmpeg/series8`
6. **FFmpeg configure** — Emscripten cross-compile with specific codecs/protocols enabled
7. **FFmpeg build**
8. **Generate exports** — `scripts/apply-funcs.js` reads `src/funcs.json` → produces `exports.json` + `post.js`
9. **Link WASM** — emcc with asyncify, produces final `.wasm.mjs` + `.wasm`

Steps are cached: each step checks for its output before running. Remove a `build/<step>` directory to force a rebuild.

### Source Files (src/)

| File | Purpose |
|------|---------|
| `bindings.c` | C bindings exposing ~150+ FFmpeg functions to JS via Emscripten macros |
| `funcs.json` | Function definitions (name, return type, params, options like `async`/`returnsErrno`) — drives code generation |
| `post.in.js` | Asyncify serialization layer — `serially()` chains async ops to prevent FFmpeg race conditions |
| `libav.in.js` | Main namespace: WASM detection, target selection (asm/wasm/thr), module loading |
| `custom-post.js` | **EYTD-specific**: jsfetch overrides with FetchWithRetry (exponential backoff), AbortSignal.any() polyfill |
| `extern-post.js` | Worker/thread message protocol (`libavjs_run`/`libavjs_ret`) |
| `pre.js` | Module initialization and WASM path resolution |

### Key Custom Patch: jsfetch Protocol

`patches/ffmpeg/07-jsfetch-protocol.diff` adds a custom FFmpeg protocol (`jsfetch:`) that bridges FFmpeg's I/O to browser `fetch()`. The HLS demuxer rewrites http/https URLs to `jsfetch:` so all network I/O flows through JavaScript. `src/custom-post.js` overrides the default jsfetch handlers with retry logic and abort controller management.

### Asyncify Pattern

FFmpeg's synchronous C API is bridged to async JavaScript via Emscripten's Asyncify. The `serially()` function in `post.in.js` enforces sequential execution through promise chaining — all FFmpeg API calls must go through this serialization to prevent corruption.

### Code Generation Flow

`scripts/apply-funcs.js` reads `src/funcs.json` + doxygen metadata → generates:
- `exports.json` (Emscripten exported function list)
- `post.js` (JavaScript wrapper functions with type conversion, 32/64-bit integer handling)
- TypeScript type definitions

## Enabled Codecs & Protocols

- **Protocols:** data, file, jsfetch (custom), crypto
- **Demuxers:** matroska, aac, hls, flv, dash, mpegts, mp3, mov, webvtt, srt, ass, ogg
- **Muxers:** mp4, matroska, hls, mp3
- **Decoders:** aac, h264 (openh264), mp3, libvpx_vp9
- **Encoders:** libmp3lame
- **Filters:** aresample, asetnsamples
- **BSFs:** h264_metadata, extract_extradata, vp9_metadata, opus_metadata

## CI

GitHub Actions (`.github/workflows/build.yml`) runs on push/PR to main. Uses Emscripten SDK 5.0.2, caches `build/` directory keyed by patches + build.sh hash, uploads dist artifacts.
