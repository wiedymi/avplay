# avplay

Browser-based media player powered by FFmpeg and WebAssembly. Features full audio/video/subtitle decoding with seeking, multi-track support, and subtitle rendering.

## Prerequisites

### For Docker Build
- Docker and Docker Compose

### For Manual Build
- Emscripten SDK (latest)
- Bun (for package demo)
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
Outputs single-file WASM module (~13MB)


## Run Demo

```bash
cd package
bun install
bun run dev
```

Open http://localhost:3000 in your browser.

## Features

- **Full codec support**: H.264, H.265, VP8/9, AV1, MPEG-4, etc.
- **Multi-track media**: Audio, video, subtitle extraction
- **Advanced features**: Seeking, metadata, chapter info
- **Subtitle rendering**: ASS/SSA with libass
- **Modular C decoder**: Full-featured implementation
- **Optimized builds**: Single-file WASM output (~13MB)
- **TypeScript support**: Full type definitions

## API
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
├── src/                    # Modular C decoder
│   ├── decoder_core.c      # Main decoder logic
│   ├── decoder_video.c     # Video decoding
│   ├── decoder_audio.c     # Audio decoding
│   ├── decoder_subtitle.c  # Subtitle handling
│   └── decoder_track.c     # Track management
├── package/                # Bun/TypeScript demo
├── build-*.sh              # Build scripts
├── ffmpeg-install/         # FFmpeg libraries
├── dav1d-install/          # AV1 decoder
└── libass-install/         # Subtitle renderer
```