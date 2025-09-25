# Dockerfile for building avplay decoder
FROM ubuntu:22.04

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    curl \
    git \
    meson \
    ninja-build \
    pkg-config \
    python3 \
    python3-pip \
    wget \
    xz-utils \
    autotools-dev \
    autoconf \
    automake \
    libtool \
    gperf \
    && rm -rf /var/lib/apt/lists/*

# Install Emscripten SDK
WORKDIR /emsdk
RUN git clone https://github.com/emscripten-core/emsdk.git . \
    && ./emsdk install latest \
    && ./emsdk activate latest

# Set up environment for Emscripten
ENV PATH="/emsdk:/emsdk/upstream/emscripten:${PATH}"
ENV EMSDK="/emsdk"

# Set working directory
WORKDIR /app

# Copy source files
COPY . .

# Build libass (includes all text rendering dependencies)
RUN chmod +x build-libass.sh && ./build-libass.sh

# Build dav1d (AV1 decoder)
RUN chmod +x build-dav1d.sh && ./build-dav1d.sh

# Build FFmpeg libavcodec
RUN chmod +x build-libavcodec.sh && ./build-libavcodec.sh

# Build C decoder - final WASM output
RUN chmod +x build-decoder.sh && ./build-decoder.sh

# Create output directory and copy decoder
RUN mkdir -p /output && cp build/decoder.js /output/

# Default command to copy output
CMD ["cp", "-r", "/output/.", "/host-output/"]
