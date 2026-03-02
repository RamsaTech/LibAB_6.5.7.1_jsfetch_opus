#!/bin/bash
# =============================================================================
# LibAB 6.8.8.0 — jsfetch opus build
# Builds libav.js WASM with h264 + aac + mp3 + vp9 + HLS/jsfetch support
# Requires: Emscripten 5.0.2, Node.js, pkg-config
# =============================================================================
set -euo pipefail

FFMPEG_VERSION=8.0
LIBAVJS_VERSION=6.8.8.0
EMFT_VERSION=1.3
LAME_VERSION=3.100
LIBVPX_VERSION=1.16.0
OPENH264_VERSION=2.6.0
OPTFLAGS="-Oz"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
INST="$BUILD/inst"

NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

mkdir -p "$BUILD" "$INST" "$ROOT/dist"

echo "==> Root:    $ROOT"
echo "==> Build:   $BUILD"
echo "==> Install: $INST"
echo "==> Jobs:    $NPROC"

# =============================================================================
# Step 1: Build emfiberthreads
# =============================================================================
if [ ! -f "$INST/lib/libemfiberthreads.a" ]; then
    echo "==> [1/9] Building emfiberthreads $EMFT_VERSION"

    if [ ! -f "$BUILD/emfiberthreads-$EMFT_VERSION.tar.gz" ]; then
        curl -L "https://github.com/Yahweasel/emfiberthreads/archive/refs/tags/v$EMFT_VERSION.tar.gz" \
            -o "$BUILD/emfiberthreads-$EMFT_VERSION.tar.gz"
    fi

    if [ ! -d "$BUILD/emfiberthreads/emfiberthreads-$EMFT_VERSION" ]; then
        mkdir -p "$BUILD/emfiberthreads"
        cd "$BUILD/emfiberthreads" && tar zxf "../emfiberthreads-$EMFT_VERSION.tar.gz"
    fi

    cd "$BUILD/emfiberthreads/emfiberthreads-$EMFT_VERSION"
    make STACK_SIZE=1048576
    make install PREFIX="$INST"
    make install-interpose PREFIX="$INST"
else
    echo "==> [1/9] emfiberthreads already built, skipping"
fi

# =============================================================================
# Step 2: Build lame (libmp3lame)
# =============================================================================
if [ ! -f "$INST/lib/libmp3lame.a" ]; then
    echo "==> [2/9] Building lame $LAME_VERSION"

    if [ ! -f "$BUILD/lame-$LAME_VERSION.tar.gz" ]; then
        curl -L "https://sourceforge.net/projects/lame/files/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz" \
            -o "$BUILD/lame-$LAME_VERSION.tar.gz"
    fi

    if [ ! -d "$BUILD/lame-$LAME_VERSION" ]; then
        cd "$BUILD" && tar zxf "lame-$LAME_VERSION.tar.gz"
    fi

    mkdir -p "$BUILD/lame-$LAME_VERSION/build-base"
    cd "$BUILD/lame-$LAME_VERSION/build-base"
    emconfigure "../../lame-$LAME_VERSION/configure" \
        --prefix="$INST" \
        --host=mipsel-sysv \
        --disable-shared \
        CFLAGS="$OPTFLAGS"
    make -j"$NPROC" install
else
    echo "==> [2/9] lame already built, skipping"
fi

# =============================================================================
# Step 3: Build libvpx
# =============================================================================
if [ ! -f "$INST/lib/libvpx.a" ]; then
    echo "==> [3/9] Building libvpx $LIBVPX_VERSION"

    if [ ! -f "$BUILD/libvpx-$LIBVPX_VERSION.tar.gz" ]; then
        curl -L "https://github.com/webmproject/libvpx/archive/refs/tags/v$LIBVPX_VERSION.tar.gz" \
            -o "$BUILD/libvpx-$LIBVPX_VERSION.tar.gz"
    fi

    if [ ! -d "$BUILD/libvpx-$LIBVPX_VERSION" ]; then
        cd "$BUILD" && tar zxf "libvpx-$LIBVPX_VERSION.tar.gz"
    fi

    mkdir -p "$BUILD/libvpx-$LIBVPX_VERSION/build-base"
    cd "$BUILD/libvpx-$LIBVPX_VERSION/build-base"
    emconfigure "../../libvpx-$LIBVPX_VERSION/configure" \
        --prefix="$INST" \
        --target=generic-gnu \
        --extra-cflags="$OPTFLAGS" \
        --enable-static --disable-shared \
        --disable-webm-io \
        --disable-examples --disable-tools --disable-docs

    # Fix oversized config string that breaks emcc
    sed 's/^.* cfg = ".*/static const char* const cfg = "";/' \
        < vpx_config.c > vpx_config.c.tmp && mv vpx_config.c.tmp vpx_config.c

    make -j"$NPROC" || true
    for lib in gtest vp9rc vpx vpxrc; do
        if [ -f "lib${lib}_g.a" ]; then
            emranlib "lib${lib}_g.a"
            cp "lib${lib}_g.a" "lib${lib}.a"
        fi
    done
    make install
else
    echo "==> [3/9] libvpx already built, skipping"
fi

# =============================================================================
# Step 4: Build openh264
# =============================================================================
if [ ! -f "$INST/lib/libopenh264.a" ]; then
    echo "==> [4/9] Building openh264 $OPENH264_VERSION"

    if [ ! -f "$BUILD/openh264-$OPENH264_VERSION.tar.gz" ]; then
        curl -L "https://github.com/cisco/openh264/archive/refs/tags/v$OPENH264_VERSION.tar.gz" \
            -o "$BUILD/openh264-$OPENH264_VERSION.tar.gz"
    fi

    if [ ! -d "$BUILD/openh264-$OPENH264_VERSION" ]; then
        cd "$BUILD" && tar zxf "openh264-$OPENH264_VERSION.tar.gz"
    fi

    cd "$BUILD/openh264-$OPENH264_VERSION"
    if [ ! -f PATCHED ]; then
        patch -p1 -i "$ROOT/patches/openh264.diff"
        touch PATCHED
    fi

    mkdir -p build-base
    cd build-base
    emmake make -j"$NPROC" -f "../../openh264-$OPENH264_VERSION/Makefile" \
        install-static OS=linux ARCH=mips \
        CFLAGS="$OPTFLAGS -fno-stack-protector" \
        PREFIX="$INST"
else
    echo "==> [4/9] openh264 already built, skipping"
fi

# =============================================================================
# Step 5: Download FFmpeg and apply patches
# =============================================================================
if [ ! -f "$BUILD/ffmpeg-$FFMPEG_VERSION/PATCHED" ]; then
    echo "==> [5/9] Downloading and patching FFmpeg $FFMPEG_VERSION"

    if [ ! -f "$BUILD/ffmpeg-$FFMPEG_VERSION.tar.xz" ]; then
        curl "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
            -o "$BUILD/ffmpeg-$FFMPEG_VERSION.tar.xz"
    fi

    if [ ! -d "$BUILD/ffmpeg-$FFMPEG_VERSION" ]; then
        cd "$BUILD" && tar Jxf "ffmpeg-$FFMPEG_VERSION.tar.xz"
    fi

    echo "    Applying patches from series8..."
    (cd "$ROOT/patches/ffmpeg" && cat $(cat series8)) | \
        (cd "$BUILD/ffmpeg-$FFMPEG_VERSION" && patch -p1)
    touch "$BUILD/ffmpeg-$FFMPEG_VERSION/PATCHED"
else
    echo "==> [5/9] FFmpeg already patched, skipping"
fi

# =============================================================================
# Step 6: Configure FFmpeg
# =============================================================================
FFBUILD="$BUILD/ffmpeg-$FFMPEG_VERSION/build-base"

if [ ! -f "$FFBUILD/ffbuild/config.mak" ]; then
    echo "==> [6/9] Configuring FFmpeg"
    mkdir -p "$FFBUILD"
    cd "$FFBUILD"

    emconfigure env PKG_CONFIG_PATH="$INST/lib/pkgconfig" \
        ../configure \
        --prefix=/opt/ffmpeg \
        --target-os=none --enable-cross-compile \
        --disable-x86asm --disable-inline-asm --disable-runtime-cpudetect \
        --cc=emcc --ranlib=emranlib \
        --disable-doc --disable-stripping --disable-programs \
        --disable-ffplay --disable-ffprobe --disable-network --disable-iconv \
        --disable-xlib --disable-sdl2 --disable-zlib --disable-everything \
        --disable-pthreads --arch=emscripten \
        --optflags="$OPTFLAGS" \
        --extra-cflags="-I$INST/include -lemfiberthreads" \
        --extra-ldflags="-L$INST/lib -lemfiberthreads -s INITIAL_MEMORY=25165824" \
        --enable-protocol=data --enable-protocol=file \
        --enable-protocol=jsfetch --enable-protocol=crypto \
        --enable-filter=aresample --enable-filter=asetnsamples \
        --enable-muxer=mp4 --enable-muxer=matroska --enable-muxer=hls --enable-muxer=mp3 \
        --enable-demuxer=matroska --enable-demuxer=aac --enable-demuxer=hls --enable-demuxer=flv \
        --enable-demuxer=dash --enable-demuxer=mpegts --enable-demuxer=mp3 --enable-demuxer=mov \
        --enable-demuxer=webvtt --enable-demuxer=srt --enable-demuxer=ass --enable-demuxer=ogg \
        --enable-parser=aac --enable-parser=h264 --enable-parser=vp9 \
        --enable-decoder=aac --enable-decoder=h264 --enable-decoder=mp3 --enable-decoder=libvpx_vp9 \
        --enable-bsf=h264_metadata --enable-bsf=extract_extradata \
        --enable-bsf=vp9_metadata --enable-bsf=opus_metadata \
        --enable-libmp3lame --enable-encoder=libmp3lame \
        --enable-libvpx \
        --enable-ffmpeg --enable-ffprobe

    # Strip extra-cflags/ldflags from config.h to avoid downstream build issues
    sed "s/--extra-\\(cflags\\|ldflags\\)='[^']*'//g" \
        < config.h > config.h.tmp && mv config.h.tmp config.h
else
    echo "==> [6/9] FFmpeg already configured, skipping"
fi

# =============================================================================
# Step 7: Build FFmpeg
# =============================================================================
if [ ! -f "$FFBUILD/libavformat/libavformat.a" ]; then
    echo "==> [7/9] Building FFmpeg"
    cd "$FFBUILD"
    make -j"$NPROC"
else
    echo "==> [7/9] FFmpeg already built, skipping"
fi

# =============================================================================
# Step 8: Generate exports.json and post.js via apply-funcs.js
# =============================================================================
if [ ! -f "$BUILD/exports.json" ] || [ ! -f "$BUILD/post.js" ]; then
    echo "==> [8/9] Generating exports and post.js"
    mkdir -p "$BUILD" "$ROOT/mk"

    # Provide empty doxygen.json (used for TS doc comments only)
    if [ ! -f "$ROOT/mk/doxygen.json" ]; then
        echo '{}' > "$ROOT/mk/doxygen.json"
    fi

    # apply-funcs.js reads from CWD-relative paths, create symlinks
    cd "$ROOT"
    ln -sf src/funcs.json funcs.json
    ln -sf src/post.in.js post.in.js
    ln -sf src/libav.in.js libav.in.js
    ln -sf src/libav.types.in.d.ts libav.types.in.d.ts

    node scripts/apply-funcs.js "$LIBAVJS_VERSION"

    # Clean up symlinks
    rm -f funcs.json post.in.js libav.in.js libav.types.in.d.ts
else
    echo "==> [8/9] exports.json and post.js already generated, skipping"
fi

# =============================================================================
# Step 9: Link with emcc → .wasm.mjs + .wasm
# =============================================================================
OUTNAME="libav-$LIBAVJS_VERSION-h264-aac-mp3"

if [ ! -f "$ROOT/dist/$OUTNAME.wasm.mjs" ]; then
    echo "==> [9/9] Linking WASM module: $OUTNAME"
    mkdir -p "$ROOT/dist"

    emcc $OPTFLAGS \
        --pre-js "$ROOT/src/pre.js" \
        --post-js "$BUILD/post.js" \
        --post-js "$ROOT/src/custom-post.js" \
        --extern-post-js "$ROOT/src/extern-post.js" \
        -s "EXPORT_NAME='LibAVFactory'" \
        -s "EXPORTED_FUNCTIONS=@$BUILD/exports.json" \
        -s "EXPORTED_RUNTIME_METHODS=['ccall','cwrap']" \
        -s MODULARIZE=1 \
        -s STACK_SIZE=1048576 \
        -s ASYNCIFY \
        -s "ASYNCIFY_IMPORTS=['libavjs_wait_reader','jsfetch_open_js','jsfetch_read_js','jsfetch_seek_js']" \
        -s INITIAL_MEMORY=25165824 \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s EXPORT_ES6=1 \
        -s USE_ES6_IMPORT_META=1 \
        -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
        -DLIBAVJS_WITH_CLI=1 \
        -DLIBAVJS_WITH_SWSCALE=1 \
        -I"$BUILD/ffmpeg-$FFMPEG_VERSION" \
        -I"$FFBUILD" \
        "$ROOT/src/bindings.c" \
        "$FFBUILD/fftools/"*.o \
        "$FFBUILD/fftools/textformat/"*.o \
        "$FFBUILD/fftools/graph/"*.o \
        "$FFBUILD/fftools/resources/"*.o \
        -L"$FFBUILD/libavdevice" -lavdevice \
        -L"$FFBUILD/libavformat" -lavformat \
        -L"$FFBUILD/libavcodec" -lavcodec \
        -L"$FFBUILD/libavfilter" -lavfilter \
        -L"$FFBUILD/libswresample" -lswresample \
        -L"$FFBUILD/libswscale" -lswscale \
        -L"$FFBUILD/libavutil" -lavutil \
        "$INST/lib/libopenh264.a" \
        "$INST/lib/libmp3lame.a" \
        -L"$INST/lib" -lvpx \
        -L"$INST/lib" -lemfiberthreads \
        -lstdc++ \
        -o "$ROOT/dist/$OUTNAME.wasm.mjs"

    echo "==> Build complete!"
    ls -lh "$ROOT/dist/$OUTNAME"*
else
    echo "==> [9/9] WASM module already built, skipping"
fi

echo ""
echo "============================================="
echo " Done. Output files in dist/"
echo "============================================="
