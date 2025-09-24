#!/bin/bash
set -e

echo "Building dav1d for WebAssembly..."

# Build dav1d (AV1 decoder)
if [ ! -d "dav1d" ]; then
    git clone --depth 1 https://code.videolan.org/videolan/dav1d.git
fi

cd dav1d
mkdir -p build-wasm
cd build-wasm

# Create a cross-compilation file for meson
cat > crossfile.txt << EOF
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
strip = 'emstrip'

[properties]
needs_exe_wrapper = true

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
EOF

# Configure dav1d for WASM
emconfigure meson setup . .. \
    --cross-file crossfile.txt \
    --default-library=static \
    -Denable_tools=false \
    -Denable_tests=false \
    -Denable_asm=false \
    -Dbitdepths='["8"]' \
    -Dbuildtype=release \
    --prefix="$(pwd)/../../dav1d-install"

# Build and install
ninja
ninja install

echo "dav1d built successfully!"
cd ../..

echo "Now rebuild FFmpeg with: --enable-libdav1d"