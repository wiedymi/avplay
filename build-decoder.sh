#!/bin/bash
set -e

echo "Building libavcodec WASM decoder with libdav1d..."

# Check if TypeScript is installed (needed for --emit-tsd)
if ! command -v tsc &> /dev/null; then
    echo "Warning: TypeScript not found. Install with 'npm install -g typescript' for .d.ts generation"
fi

# Create build output directory
mkdir -p build

FFMPEG_INSTALL="$(pwd)/ffmpeg-install"
LIBASS_INSTALL="$(pwd)/libass-install"

# First rebuild FFmpeg if swresample is not available
if [ ! -f "${FFMPEG_INSTALL}/lib/libswresample.a" ]; then
    echo "libswresample not found, rebuilding FFmpeg..."
    rm -rf ffmpeg-build ffmpeg-install
    ./build-libavcodec.sh
fi

# Debug: Check what libraries were built
echo "=== Debug: Available libraries ==="
ls -la "${LIBASS_INSTALL}/lib/"*.a 2>/dev/null || echo "No libass libraries found"
echo "=== Debug: Looking for fontconfig specifically ==="
find "${LIBASS_INSTALL}" -name "*fontconfig*" -type f 2>/dev/null || echo "No fontconfig files found"
echo

# Compile all decoder C files with Emscripten including libass and SIMD support
# Using WASM Workers instead of pthreads for better worker-to-worker communication
emcc -msimd128 -flto src/decoder_core.c src/decoder_utils.c src/decoder_video.c src/decoder_audio.c src/decoder_subtitle.c src/decoder_track.c src/decoder_sync.c \
    -I${FFMPEG_INSTALL}/include \
    -L${FFMPEG_INSTALL}/lib \
    -I./dav1d-install/include \
    -L./dav1d-install/lib \
    -I${LIBASS_INSTALL}/include \
    -L${LIBASS_INSTALL}/lib \
    -lavformat -lavcodec -lavfilter -lswscale -lswresample -lavutil -ldav1d \
    -lass -lfontconfig -lharfbuzz -lfreetype -lexpat -lbrotlidec -lbrotlicommon -lfribidi \
    -O3 -msimd128 -flto -ffast-math \
    -s WASM=1 \
    -s WASM_WORKERS=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='createDecoderModule' \
    -s EXPORTED_FUNCTIONS='["_decoder_create","_decoder_init_format","_decoder_decode_frame","_decoder_get_width","_decoder_get_height","_decoder_get_frame_rgb","_decoder_has_audio","_decoder_get_audio_sample_rate","_decoder_get_audio_channels","_decoder_get_audio_buffer_size","_decoder_get_audio_buffer","_decoder_clear_audio_buffer","_decoder_destroy","_decoder_get_codec_name","_decoder_get_audio_codec_name","_decoder_get_video_track_count","_decoder_get_video_track_info","_decoder_switch_video_track","_decoder_switch_audio_track","_decoder_get_subtitle_track_count","_decoder_get_subtitle_track_info","_decoder_switch_subtitle_track","_decoder_enable_filter_subtitles","_decoder_render_subtitles_filter","_decoder_get_attachment_count","_decoder_get_attachment_info","_decoder_get_attachment_data","_decoder_get_attachment_size","_decoder_extract_track_start","_decoder_extract_track_chunk","_decoder_extract_track_end","_decoder_seek","_decoder_get_duration","_decoder_get_version","_decoder_set_thread_count","_decoder_get_thread_count","_decoder_init_sync","_decoder_cleanup_sync","_decoder_get_sync_stats","_decoder_get_audio_buffer_health","_decoder_audio_needs_more_data","_decoder_get_frame_timestamp","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","stringToUTF8","lengthBytesUTF8","HEAP8","HEAPU8","HEAPF32"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=134217728 \
    -s MAXIMUM_MEMORY=2147483648 \
    -s MALLOC=mimalloc \
    -s MEMORY_GROWTH_GEOMETRIC_STEP=1.0 \
    -s STACK_SIZE=1048576 \
    -s WASM_BIGINT=1 \
    -s TEXTDECODER=2 \
    -s ASSERTIONS=0 \
    -s ENVIRONMENT='web,worker' \
    -s EXPORT_ES6=0 \
    --closure 1 \
    --emit-tsd decoder.d.ts \
    -o build/decoder.js

echo "Build complete! Output: build/decoder.js, build/decoder.wasm, and build/decoder.d.ts"
ls -lh build/decoder.*
cp build/decoder.js output/decoder.js
cp build/decoder.wasm output/decoder.wasm
if [ -f build/decoder.d.ts ]; then
    cp build/decoder.d.ts output/decoder.d.ts
    echo "TypeScript definitions copied to output/decoder.d.ts"
fi
