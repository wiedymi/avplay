# @avplay/decoder

Low-level WebAssembly decoder package providing FFmpeg-powered media decoding capabilities.

## Overview

This package contains:
- Pre-built WebAssembly decoder (`decoder.js`) - single-file WASM module (~13MB)
- Web Worker wrapper (`decoder-worker.js`) for non-blocking decoding
- TypeScript type definitions for the decoder API

## Installation

```bash
bun add @avplay/decoder
# or
npm install @avplay/decoder
```

## Usage

### Basic Usage

```javascript
import decoderModule from '@avplay/decoder/decoder.js';

// Initialize the WASM module
const decoder = await decoderModule();

// Create decoder instance
const dec = new decoder.Decoder();

// Load media file (Uint8Array)
const result = dec.load_data(mediaBuffer);
if (result.success) {
  // Get media info
  const info = dec.get_file_info();
  console.log('Duration:', info.duration);
  console.log('Tracks:', info.trackCounts);

  // Decode video frame at 1.5 seconds
  const frame = dec.decode_video_frame(0, 1.5); // track 0, time 1.5s
  if (frame) {
    // Access RGB data
    console.log('Frame:', frame.width, 'x', frame.height);
    console.log('RGB data:', frame.rgbData);
  }
}

// Cleanup
dec.destroy();
```

### Web Worker Usage

```javascript
import DecoderWorker from '@avplay/decoder/decoder-worker.js';

const worker = new DecoderWorker();

// Send media data to worker
worker.postMessage({
  type: 'load',
  data: mediaBuffer
});

// Listen for decoded frames
worker.onmessage = (event) => {
  const { type, data } = event.data;

  if (type === 'frame') {
    // Render frame data
    const { width, height, rgbData } = data;
    // ... render to canvas
  }
};
```

## API Reference

### Decoder Methods

#### `load_data(buffer: Uint8Array): LoadResult`
Load media file from buffer.

#### `get_file_info(): FileInfo`
Get media information including tracks, duration, codecs.

#### `decode_video_frame(trackIndex: number, timeSeconds: number): FrameData | null`
Decode video frame at specific time.

#### `decode_audio_frame(trackIndex: number, timeSeconds: number): FrameData | null`
Decode audio samples at specific time.

#### `seek(timeSeconds: number): boolean`
Seek to specific time position.

#### `switch_video_track(trackIndex: number): boolean`
Switch active video track.

#### `switch_audio_track(trackIndex: number): boolean`
Switch active audio track.

#### `destroy(): void`
Clean up decoder resources.

### Types

```typescript
interface FrameData {
  width: number;
  height: number;
  rgbData: Uint8ClampedArray;
  codecName?: string;
  audioData?: Float32Array;
  audioSampleRate?: number;
  audioChannels?: number;
  timestamp?: number;
}

interface FileInfo {
  videoTracks: string[];
  audioTracks: string[];
  subtitleTracks: string[];
  attachments: string[];
  codecName: string;
  audioCodec?: string;
  hasAudio: boolean;
  duration: number;
  trackCounts: {
    video: number;
    audio: number;
    subtitle: number;
    attachment: number;
  };
}
```

## Supported Formats

- **Video**: H.264, H.265/HEVC, VP8, VP9, AV1, MPEG-4, MPEG-2
- **Audio**: AAC, MP3, Opus, Vorbis, FLAC, PCM
- **Containers**: MP4, MKV, WebM, AVI, MOV, FLV
- **Subtitles**: ASS/SSA, SRT, VTT (with libass rendering)

## Performance

The decoder is optimized for web deployment:
- Single-file WASM module (~13MB)
- Memory pool for efficient allocations
- Hardware-accelerated where available
- Web Worker support for non-blocking operation

## Building from Source

This package includes pre-built binaries. To build from source:

```bash
# Build dependencies
./build-dav1d.sh
./build-libass.sh
./build-libavcodec.sh

# Build WASM decoder
./build-decoder.sh

# Build TypeScript wrapper
cd avplay/decoder
bun run build
```

The decoder will be output to `output/decoder.js`.