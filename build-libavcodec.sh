#!/bin/bash

set -e

FFMPEG_VERSION="7.1.2"
BUILD_DIR="ffmpeg-build"
INSTALL_DIR="$(pwd)/ffmpeg-install"

if [ ! -d "$BUILD_DIR" ]; then
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"

    echo "Downloading FFmpeg $FFMPEG_VERSION..."
    curl -L "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o ffmpeg.tar.xz
    tar -xf ffmpeg.tar.xz
    cd "ffmpeg-$FFMPEG_VERSION"
else
    cd "$BUILD_DIR/ffmpeg-$FFMPEG_VERSION"
fi

echo "Configuring FFmpeg for WASM (libavcodec + libavutil only)..."

# Set PKG_CONFIG_PATH for dependencies
export PKG_CONFIG_PATH=""

# Add dav1d if it exists
if [ -d "../../dav1d-install/lib/pkgconfig" ]; then
    export PKG_CONFIG_PATH="$(pwd)/../../dav1d-install/lib/pkgconfig:$PKG_CONFIG_PATH"
    export CFLAGS="-I$(pwd)/../../dav1d-install/include $CFLAGS"
    export LDFLAGS="-L$(pwd)/../../dav1d-install/lib $LDFLAGS"
    echo "Found dav1d at: $(pwd)/../../dav1d-install"
fi

# Add libass if it exists
if [ -d "../../libass-install/lib/pkgconfig" ]; then
    export PKG_CONFIG_PATH="$(pwd)/../../libass-install/lib/pkgconfig:$PKG_CONFIG_PATH"
    export CFLAGS="-I$(pwd)/../../libass-install/include $CFLAGS"
    export LDFLAGS="-L$(pwd)/../../libass-install/lib $LDFLAGS"
    echo "Found libass at: $(pwd)/../../libass-install"
fi

emconfigure env PKG_CONFIG_PATH="$PKG_CONFIG_PATH" \
    CFLAGS="$CFLAGS" \
    LDFLAGS="$LDFLAGS" \
    ./configure \
    --prefix="$INSTALL_DIR" \
    --target-os=none \
    --arch=x86_32 \
    --enable-cross-compile \
    --disable-programs \
    --disable-doc \
    --enable-swresample \
    --enable-swscale \
    --disable-postproc \
    --enable-avfilter \
    --enable-filter=subtitles \
    --enable-libass \
    --enable-avformat \
    --disable-avdevice \
    --disable-network \
    --disable-debug \
    --disable-stripping \
    --enable-small \
    --enable-gpl \
    --enable-version3 \
    --enable-nonfree \
    --enable-decoders \
    --enable-libdav1d \
    --disable-encoders \
    --enable-parsers \
    --disable-demuxers \
    --enable-demuxer=mov,mp4,m4a,3gp,3g2,mj2 \
    --enable-demuxer=avi \
    --enable-demuxer=matroska,webm \
    --enable-demuxer=flv \
    --enable-demuxer=mpegts \
    --enable-demuxer=mpegps \
    --enable-demuxer=ogg \
    --enable-demuxer=wav \
    --enable-demuxer=mp3 \
    --enable-demuxer=aac \
    --enable-demuxer=flac \
    --enable-demuxer=h264 \
    --enable-demuxer=hevc \
    --enable-demuxer=m4v \
    --enable-demuxer=ivf \
    --enable-demuxer=rawvideo \
    --enable-demuxer=ass \
    --enable-demuxer=srt \
    --enable-demuxer=webvtt \
    --disable-muxers \
    --enable-muxer=matroska \
    --enable-muxer=mp4 \
    --enable-muxer=avi \
    --enable-muxer=flv \
    --enable-muxer=mpegts \
    --enable-muxer=m4v \
    --enable-muxer=mp3 \
    --enable-muxer=adts \
    --enable-muxer=ac3 \
    --enable-muxer=flac \
    --enable-muxer=ogg \
    --enable-muxer=wav \
    --enable-muxer=webm \
    --enable-muxer=ass \
    --enable-muxer=srt \
    --enable-muxer=webvtt \
    --disable-protocols \
    --enable-protocol=file \
    --disable-asm \
    --disable-x86asm \
    --disable-inline-asm \
    --enable-pthreads \
    --disable-w32threads \
    --disable-os2threads \
    --disable-vulkan \
    --disable-cuda \
    --disable-cuvid \
    --disable-nvenc \
    --disable-vaapi \
    --disable-vdpau \
    --disable-videotoolbox \
    --cc=emcc \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-O3 -fno-exceptions -fno-rtti -pthread -flto -msimd128 -ffast-math" \
    --extra-cxxflags="-O3 -fno-exceptions -fno-rtti -pthread -flto -msimd128" \
    --extra-ldflags="-O3 -pthread -flto -s INITIAL_MEMORY=33554432" \
    --pkg-config-flags="--static"

echo "Building FFmpeg libraries..."
emmake make -j$(nproc)

echo "Installing libraries..."
emmake make install

echo "Build complete! Libraries installed in $INSTALL_DIR"
echo "Static libraries:"
ls -la "$INSTALL_DIR/lib/"*.a