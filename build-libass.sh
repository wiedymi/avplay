#!/bin/bash

# Build libass for WASM using proven JavascriptSubtitlesOctopus approach
# Based on: https://github.com/libass/JavascriptSubtitlesOctopus

set -e

# Check build dependencies
if [ -z "$EMSDK" ]; then
    if command -v emcc >/dev/null 2>&1; then
        echo "Found emcc, setting up Emscripten environment..."
        export EMSDK=$(dirname $(dirname $(which emcc)))
    else
        echo "Error: Emscripten SDK not found. Please install emsdk first."
        exit 1
    fi
fi

# Check for meson (required for HarfBuzz 11.5.0)
if ! command -v meson >/dev/null 2>&1; then
    echo "Error: meson not found. Please install meson:"
    echo "  brew install meson (macOS)"
    echo "  pip install meson (pip)"
    exit 1
fi

# Check for cmake (required for Expat and Brotli)
if ! command -v cmake >/dev/null 2>&1; then
    echo "Error: cmake not found. Please install cmake:"
    echo "  brew install cmake (macOS)"
    echo "  pip install cmake (pip)"
    exit 1
fi

echo "Build tools check:"
echo "  emcc: $(which emcc)"
echo "  meson: $(which meson)"
echo "  cmake: $(which cmake)"

# Use absolute latest versions 2025
LIBASS_VERSION="0.17.4"      # Latest 2025 stable version
FREETYPE_VERSION="2.14.1"    # Latest stable (emergency release)
HARFBUZZ_VERSION="11.5.0"    # Latest stable (meson)
FRIBIDI_VERSION="1.0.15"     # Latest stable
EXPAT_VERSION="2.6.2"        # Latest stable
BROTLI_VERSION="1.1.0"       # Latest stable
FONTCONFIG_VERSION="2.15.0"  # Latest stable

INSTALL_DIR="$(pwd)/libass-install"
BUILD_DIR="$(pwd)/libass-build"

# Create directories
mkdir -p "$BUILD_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib"
mkdir -p "$INSTALL_DIR/include"

echo "=== Building libass for WASM (JavascriptSubtitlesOctopus approach) ==="
echo "Install directory: $INSTALL_DIR"
echo "Build directory: $BUILD_DIR"
echo "Emscripten: $(which emcc)"
echo

cd "$BUILD_DIR"

# Isolate Emscripten environment completely
export CFLAGS="-O3 -flto -s WASM=1"
export CXXFLAGS="-O3 -flto -s WASM=1"
export LDFLAGS="-O3 -flto -s WASM=1"

# Clear all system paths to prevent contamination
unset PKG_CONFIG_PATH
unset PKG_CONFIG_LIBDIR
unset CPPFLAGS
unset LDFLAGS_SAVE

# Set WASM-only environment
export PKG_CONFIG_PATH="$INSTALL_DIR/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$INSTALL_DIR/lib/pkgconfig"
export CPPFLAGS="-I$INSTALL_DIR/include"
export LDFLAGS="-L$INSTALL_DIR/lib $LDFLAGS"

# Emscripten toolchain only
export CC="emcc"
export CXX="em++"
export AR="emar"
export RANLIB="emranlib"
export STRIP="emstrip"
export NM="emnm"

# Force cross-compilation and avoid system detection - use x86 target for autotools compatibility
export CROSS_COMPILE="wasm32-unknown-emscripten-"
HOST_CONFIG="--host=i686-linux-gnu --build=x86_64-linux-gnu"

# Disable autotools caching to prevent cross-contamination
export CONFIG_SITE=""

# Build dependencies in order (based on JavascriptSubtitlesOctopus)

echo "=== Building FriBidi $FRIBIDI_VERSION ==="
if [ ! -f "fribidi-$FRIBIDI_VERSION.tar.xz" ]; then
    wget "https://github.com/fribidi/fribidi/releases/download/v$FRIBIDI_VERSION/fribidi-$FRIBIDI_VERSION.tar.xz"
fi

if [ ! -d "fribidi-$FRIBIDI_VERSION" ]; then
    tar -xf "fribidi-$FRIBIDI_VERSION.tar.xz"
fi

cd "fribidi-$FRIBIDI_VERSION"
if [ ! -f "Makefile" ]; then
    autoreconf -fiv 2>/dev/null || true
    emconfigure ./configure \
        --prefix="$INSTALL_DIR" \
        $HOST_CONFIG \
        --disable-shared \
        --enable-static \
        --disable-docs \
        --disable-dependency-tracking \
        CFLAGS="$CFLAGS" \
        CXXFLAGS="$CXXFLAGS" \
        LDFLAGS="$LDFLAGS"
fi
emmake make -j$(nproc) && emmake make install
cd "$BUILD_DIR"

echo "=== Building Expat $EXPAT_VERSION ==="
if [ ! -f "expat-$EXPAT_VERSION.tar.xz" ]; then
    wget "https://github.com/libexpat/libexpat/releases/download/R_${EXPAT_VERSION//./_}/expat-$EXPAT_VERSION.tar.xz"
fi

if [ ! -d "expat-$EXPAT_VERSION" ]; then
    tar -xf "expat-$EXPAT_VERSION.tar.xz"
fi

cd "expat-$EXPAT_VERSION"
if [ ! -d "build" ]; then
    emcmake cmake -S . -B build \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DEXPAT_BUILD_DOCS=OFF \
        -DEXPAT_SHARED_LIBS=OFF \
        -DEXPAT_BUILD_EXAMPLES=OFF \
        -DEXPAT_BUILD_FUZZERS=OFF \
        -DEXPAT_BUILD_TESTS=OFF \
        -DEXPAT_BUILD_TOOLS=OFF \
        -DCMAKE_C_FLAGS="$CFLAGS" \
        -DCMAKE_CXX_FLAGS="$CXXFLAGS"
fi
cd build
emmake make -j$(nproc) && emmake make install
cd "$BUILD_DIR"

echo "=== Building Brotli $BROTLI_VERSION ==="
if [ ! -f "brotli-$BROTLI_VERSION.tar.gz" ]; then
    wget "https://github.com/google/brotli/archive/refs/tags/v$BROTLI_VERSION.tar.gz" -O "brotli-$BROTLI_VERSION.tar.gz"
fi

if [ ! -d "brotli-$BROTLI_VERSION" ]; then
    tar -xf "brotli-$BROTLI_VERSION.tar.gz"
fi

cd "brotli-$BROTLI_VERSION"
if [ ! -d "build" ]; then
    emcmake cmake -S . -B build \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DCMAKE_C_FLAGS="$CFLAGS" \
        -DCMAKE_CXX_FLAGS="$CXXFLAGS"
fi
cd build
emmake make -j$(nproc) && emmake make install
# Normalize static lib names
cd "$INSTALL_DIR/lib/"
for lib in *-static.a; do
    if [ -f "$lib" ]; then
        mv "$lib" "${lib%-static.a}.a"
    fi
done
cd "$BUILD_DIR"

echo "=== Building FreeType $FREETYPE_VERSION (stage 1: without HarfBuzz) ==="
if [ ! -f "freetype-$FREETYPE_VERSION.tar.xz" ]; then
    wget "https://download.savannah.gnu.org/releases/freetype/freetype-$FREETYPE_VERSION.tar.xz"
fi

if [ ! -d "freetype-$FREETYPE_VERSION" ]; then
    tar -xf "freetype-$FREETYPE_VERSION.tar.xz"
fi

cd "freetype-$FREETYPE_VERSION"

# Build FreeType stage 1 (without HarfBuzz) using CMake for better cross-compilation support
if [ ! -d "build_hb" ]; then
    mkdir -p build_hb
    cd build_hb
    FREETYPE_STAGE1_PREFIX="$(pwd)/dist_hb"
    emcmake cmake .. \
        -DCMAKE_INSTALL_PREFIX="$FREETYPE_STAGE1_PREFIX" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DFT_DISABLE_HARFBUZZ=ON \
        -DFT_DISABLE_BROTLI=ON \
        -DFT_DISABLE_PNG=ON \
        -DFT_DISABLE_ZLIB=ON \
        -DFT_DISABLE_BZIP2=ON \
        -DCMAKE_C_FLAGS="$CFLAGS" \
        -DCMAKE_CXX_FLAGS="$CXXFLAGS"
    emmake make -j$(nproc) && emmake make install
    cd ..
fi
cd "$BUILD_DIR"

echo "=== Building HarfBuzz $HARFBUZZ_VERSION ==="
if [ ! -f "harfbuzz-$HARFBUZZ_VERSION.tar.xz" ]; then
    wget "https://github.com/harfbuzz/harfbuzz/releases/download/$HARFBUZZ_VERSION/harfbuzz-$HARFBUZZ_VERSION.tar.xz"
fi

if [ ! -d "harfbuzz-$HARFBUZZ_VERSION" ]; then
    tar -xf "harfbuzz-$HARFBUZZ_VERSION.tar.xz"
fi

cd "harfbuzz-$HARFBUZZ_VERSION"

# HarfBuzz uses meson build system
mkdir -p build-wasm
cd build-wasm

# Create cross-compilation file
cat > crossfile.txt << EOF
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
strip = 'emstrip'
pkgconfig = 'pkg-config'

[properties]
needs_exe_wrapper = true

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
EOF

# Export PKG_CONFIG_PATH for meson to find (include FreeType stage 1)
export PKG_CONFIG_PATH="$INSTALL_DIR/lib/pkgconfig:$BUILD_DIR/freetype-$FREETYPE_VERSION/build_hb/dist_hb/lib/pkgconfig:$PKG_CONFIG_PATH"

# Debug: Check if freetype2.pc exists
echo "=== Debug: Looking for freetype2.pc ==="
echo "PKG_CONFIG_PATH: $PKG_CONFIG_PATH"
find "$BUILD_DIR/freetype-$FREETYPE_VERSION/build_hb/dist_hb" -name "*.pc" -type f 2>/dev/null || echo "No .pc files found in FreeType stage 1"
ls -la "$BUILD_DIR/freetype-$FREETYPE_VERSION/build_hb/dist_hb/lib/pkgconfig/" 2>/dev/null || echo "pkgconfig directory not found"
pkg-config --list-all | grep freetype || echo "No freetype found in pkg-config"

# Use emconfigure with proper PKG_CONFIG setup
emconfigure env \
	PKG_CONFIG="pkg-config" \
	PKG_CONFIG_PATH="$PKG_CONFIG_PATH" \
	CFLAGS="-DHB_NO_MT $CFLAGS" \
	CXXFLAGS="-DHB_NO_MT $CFLAGS" \
	LDFLAGS="-L$INSTALL_DIR/lib $LDFLAGS" \
	meson setup . .. \
	--cross-file crossfile.txt \
	--default-library=static \
	--prefix="$INSTALL_DIR" \
	-Dfreetype=enabled \
	-Dglib=disabled \
	-Dgobject=disabled \
	-Dcairo=disabled \
	-Dicu=disabled \
	-Dgraphite=disabled \
	-Dtests=disabled \
	-Ddocs=disabled

# Build and install
ninja
ninja install
cd "$BUILD_DIR"

echo "=== Building Fontconfig $FONTCONFIG_VERSION ==="
if [ ! -f "fontconfig-$FONTCONFIG_VERSION.tar.xz" ]; then
    wget "https://www.freedesktop.org/software/fontconfig/release/fontconfig-$FONTCONFIG_VERSION.tar.xz"
fi

if [ ! -d "fontconfig-$FONTCONFIG_VERSION" ]; then
    tar -xf "fontconfig-$FONTCONFIG_VERSION.tar.xz"
fi

cd "fontconfig-$FONTCONFIG_VERSION"
if [ ! -f "Makefile" ]; then
    autoreconf -fiv 2>/dev/null || true
    # Add FreeType stage 1 pkgconfig path for Fontconfig to find freetype2.pc
    emconfigure env PKG_CONFIG_PATH="$INSTALL_DIR/lib/pkgconfig:$BUILD_DIR/freetype-$FREETYPE_VERSION/build_hb/dist_hb/lib/pkgconfig:$PKG_CONFIG_PATH" \
        ./configure \
        --prefix="$INSTALL_DIR" \
        $HOST_CONFIG \
        --disable-shared \
        --enable-static \
        --disable-docs \
        --with-default-fonts=/fonts \
        --disable-dependency-tracking \
        CFLAGS="$CFLAGS" \
        CXXFLAGS="$CXXFLAGS" \
        LDFLAGS="$LDFLAGS"
fi
# Build fontconfig library and tools separately
emmake make -j$(nproc) -C src/ && emmake make -C src/ install
emmake make -C fontconfig/ install
emmake make install-pkgconfigDATA

# Debug: Check if libfontconfig.a was built
echo "=== Debug: Checking fontconfig library ==="
find . -name "libfontconfig*" -type f 2>/dev/null || echo "No libfontconfig library found"
cd "$BUILD_DIR"

echo "=== Rebuilding FreeType $FREETYPE_VERSION (stage 2: with HarfBuzz) ==="
cd "freetype-$FREETYPE_VERSION"
if [ ! -d "build_final" ]; then
    mkdir -p build_final
    cd build_final
    # Use CMake for stage 2 as well to ensure consistent pkg-config detection
    emcmake cmake .. \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DFT_DISABLE_HARFBUZZ=OFF \
        -DFT_DISABLE_BROTLI=OFF \
        -DFT_DISABLE_PNG=ON \
        -DFT_DISABLE_ZLIB=ON \
        -DFT_DISABLE_BZIP2=ON \
        -DCMAKE_C_FLAGS="$CFLAGS" \
        -DCMAKE_CXX_FLAGS="$CXXFLAGS"
    emmake make -j$(nproc) && emmake make install
    cd ..
fi
cd "$BUILD_DIR"

echo "=== Building libass $LIBASS_VERSION ==="
if [ ! -f "libass-$LIBASS_VERSION.tar.xz" ]; then
    wget "https://github.com/libass/libass/releases/download/$LIBASS_VERSION/libass-$LIBASS_VERSION.tar.xz"
fi

if [ ! -d "libass-$LIBASS_VERSION" ]; then
    tar -xf "libass-$LIBASS_VERSION.tar.xz"
fi

cd "libass-$LIBASS_VERSION"
if [ ! -f "Makefile" ]; then
    # Generate configure script if needed
    ./autogen.sh 2>/dev/null || true

    # Add PKG_CONFIG_PATH for libass to find all dependencies
    emconfigure env PKG_CONFIG_PATH="$PKG_CONFIG_PATH" ./configure \
        --prefix="$INSTALL_DIR" \
        $HOST_CONFIG \
        --disable-shared \
        --enable-static \
        --enable-fontconfig \
        --enable-large-tiles \
        --disable-require-system-font-provider \
        --disable-asm \
        --disable-dependency-tracking \
        --with-freetype \
        --with-harfbuzz \
        --with-fribidi \
        CFLAGS="$CFLAGS" \
        CXXFLAGS="$CXXFLAGS" \
        LDFLAGS="$LDFLAGS"
fi
emmake make -j$(nproc) || emmake make
emmake make install
cd "$BUILD_DIR"

echo "=== Build completed successfully ==="
echo "Libraries installed in: $INSTALL_DIR"
echo
echo "Library files:"
ls -la "$INSTALL_DIR/lib/"*.a 2>/dev/null || echo "No static libraries found"
echo
echo "Include files:"
ls -la "$INSTALL_DIR/include/" 2>/dev/null || echo "No include files found"
echo
echo "To use these libraries, add to your build:"
echo "  -I$INSTALL_DIR/include"
echo "  -L$INSTALL_DIR/lib -lass -lfontconfig -lharfbuzz -lfreetype -lexpat -lbrotlidec -lbrotlicommon -lfribidi"