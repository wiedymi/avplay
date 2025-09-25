# avplay

Browser-based media player powered by FFmpeg and WebAssembly. Features full audio/video/subtitle decoding with seeking, multi-track support, and subtitle rendering.

## Prerequisites

### For Docker Build
- Docker and Docker Compose

### For Manual Build
- Emscripten SDK (latest)
- Bun (for demo development)
- Meson (for dav1d build)

## Setup

1. Install Emscripten:
```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
```

## Build

### Docker Build (Recommended)

```bash
# Build decoder using Docker
docker-compose run build

# Output will be in ./output/decoder.js
```

### Manual Build

1. Build dependencies:
```bash
./build-dav1d.sh     # AV1 decoder
./build-libass.sh    # Subtitle rendering
```

2. Build FFmpeg libraries:
```bash
./build-libavcodec.sh
```

3. Build C decoder:
```bash
./build-decoder.sh
```
Outputs single-file WASM module (~13MB). The `@avplay/decoder` package expects `decoder.js` to exist in `output/` (for local builds) or be provided via the published package.

4. Build workspace packages (TypeScript):
```bash
bun run build
```

## Run Demo

```bash
# From root directory - builds packages and starts demo
bun run dev

# Or manually:
cd demo
bun install
bun run dev
```

Open http://localhost:3000 in your browser.

The default asset URLs used by `@avplay/core` are hosted on a CDN:
- `https://unpkg.com/@avplay/decoder@0.9.0/dist/decoder.js`
- `https://unpkg.com/@avplay/decoder@0.9.0/dist/decoder.wasm`
- `https://unpkg.com/@avplay/decoder@0.9.0/dist/decoder-worker.js`

You can override these via the `assets` option if you want to self-host.

## Features

- **Full codec support**: H.264, H.265, VP8/9, AV1, MPEG-4, etc.
- **Multi-track media**: Audio, video, subtitle extraction
- **Advanced features**: Seeking, metadata, chapter info
- **Subtitle rendering**: ASS/SSA with libass
- **Modular C decoder**: Full-featured implementation
- **Optimized builds**: Single-file WASM output (~13MB)
- **TypeScript support**: Full type definitions
- **Monorepo structure**: Organized workspace packages

## API

The decoder exposes a comprehensive C API compiled to WebAssembly:

```javascript
// Load decoder module
const decoder = await import('./decoder.js');
await decoder.default();

// Create decoder instance
const dec = new decoder.Decoder();

// Load and decode media
const result = dec.load_data(uint8Array);
if (result.success) {
  const tracks = dec.get_tracks();
  const frame = dec.decode_video_frame(0, 1.5); // track 0, time 1.5s
}
```

## Structure

```
avplay/
├── src/                    # Modular C decoder (C, built to WASM)
│   ├── decoder_core.c      # Main decoder logic and initialization
│   ├── decoder_video.c     # Video frame decoding and conversion
│   ├── decoder_audio.c     # Audio sample extraction and resampling
│   ├── decoder_subtitle.c  # Subtitle parsing and libass rendering
│   ├── decoder_track.c     # Multi-track handling and seeking
│   ├── decoder_utils.c     # Utility functions and buffer management
│   ├── decoder.h           # Public API definitions
│   └── decoder_common.h    # Internal shared definitions
├── demo/                   # Bun/TypeScript demo application
├── avplay/                 # Workspace packages
│   ├── decoder/            # @avplay/decoder - WASM decoder + worker + types
│   ├── core/               # @avplay/core - Player, renderers, uses @avplay/decoder
│   └── react/              # @avplay/react - React bindings
├── build-*.sh              # Build scripts for dependencies
├── ffmpeg-install/         # FFmpeg libraries (generated)
├── dav1d-install/          # AV1 decoder (generated)
├── libass-install/         # Subtitle renderer (generated)
├── build/                  # Local build output (generated)
├── output/                 # Docker build output (generated)
├── Dockerfile              # Containerized build environment
└── docker-compose.yml      # Build orchestration

## Using in your app

`@avplay/core` depends on `@avplay/decoder`. You must host and provide URLs for the decoder worker and script (or use the defaults `/decoder-worker.js` and `/decoder.js`).

Example with `@avplay/react` hook:

```tsx
import { useAvplay } from "@avplay/react";

const { canvasRef } = useAvplay({
  assets: {
    workerUrl: "/decoder-worker.js",
    decoderUrl: "/decoder.js",
  },
});
```

If you build the decoder locally, copy `output/decoder.js` to your public path as `/decoder.js`. Otherwise, when installing `@avplay/decoder` from the registry, copy from `node_modules/@avplay/decoder/dist/`.
```