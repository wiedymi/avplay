# @avplay/core

High-level media player API built on top of `@avplay/decoder`, providing advanced rendering capabilities and playback control.

## Overview

This package provides:
- `AvplayPlayer` - Complete media player with playback controls
- Multiple rendering backends (Canvas2D, WebGL2, WebGPU)
- Decoder management and worker integration
- Performance monitoring and frame statistics
- State management for media playback

## Installation

```bash
bun add @avplay/core
# or
npm install @avplay/core
```

## Usage

### Basic Player Setup

```javascript
import { AvplayPlayer } from '@avplay/core';

const canvas = document.getElementById('video-canvas');
const player = new AvplayPlayer({
  canvas,
  preferredRenderer: 'webgl', // 'canvas2d', 'webgl', or 'webgpu'
  powerPreference: 'high-performance',
  assets: {
    workerUrl: '/decoder-worker.js',
    decoderUrl: '/decoder.js'
  }
});

// Load and play media
await player.loadFile(mediaBuffer);
await player.play();

// Get player state
const state = player.getState();
console.log('Playing:', state.isPlaying);
console.log('Duration:', state.videoDuration);
console.log('Current time:', state.currentTime);
```

### Event Handling

```javascript
// Listen for state changes
player.onStateChange = (state) => {
  console.log('Playback state:', state.playbackState);
  console.log('Progress:', state.progressPercent + '%');
};

// Frame callback for custom rendering
player.onFrame = (frameData) => {
  // Access decoded frame data
  console.log('Frame:', frameData.width, 'x', frameData.height);
  // Custom processing of RGB data
};
```

### Playback Control

```javascript
// Playback controls
await player.play();
await player.pause();
await player.seek(30.5); // Seek to 30.5 seconds

// Track switching
await player.switchVideoTrack(1);
await player.switchAudioTrack(0);

// Volume and muting
player.setMuted(true);
player.setVolume(0.8);

// Cleanup
player.dispose();
```

### Advanced Rendering

```javascript
// Use specific renderer
const player = new AvplayPlayer({
  canvas,
  preferredRenderer: 'webgpu', // Best performance
});

// Or fallback chain
const player = new AvplayPlayer({
  canvas,
  preferredRenderer: 'webgl', // Falls back to canvas2d if not available
});

// Access renderer directly
const renderer = player.getRenderer();
if (renderer.kind === 'webgl') {
  // WebGL-specific operations
}
```

## API Reference

### AvplayPlayer

#### Constructor Options

```typescript
interface AvplayPlayerOptions {
  canvas: HTMLCanvasElement;
  preferredRenderer?: 'canvas2d' | 'webgl' | 'webgpu';
  powerPreference?: 'high-performance' | 'low-power';
  assets?: {
    workerUrl?: string;  // Default: '/decoder-worker.js'
    decoderUrl?: string; // Default: '/decoder.js'
  };
}
```

#### Methods

- `loadFile(buffer: Uint8Array): Promise<void>` - Load media file
- `play(): Promise<void>` - Start playback
- `pause(): Promise<void>` - Pause playback
- `seek(timeSeconds: number): Promise<void>` - Seek to time
- `switchVideoTrack(index: number): Promise<void>` - Switch video track
- `switchAudioTrack(index: number): Promise<void>` - Switch audio track
- `setMuted(muted: boolean): void` - Set mute state
- `setVolume(volume: number): void` - Set volume (0-1)
- `getState(): AvplayPlayerState` - Get current state
- `dispose(): void` - Clean up resources

#### Events

- `onStateChange?: (state: AvplayPlayerState) => void` - State updates
- `onFrame?: (frame: FrameData) => void` - New frame decoded
- `onError?: (error: Error) => void` - Error occurred

### Player State

```typescript
interface AvplayPlayerState {
  // Playback info
  playbackState: 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'SEEKING' | 'BUFFERING';
  isPlaying: boolean;
  isMuted: boolean;

  // Timing
  currentTime: number;
  videoDuration: number;
  progressPercent: number;

  // Frame info
  currentFrame: number;
  frameRate: number;
  totalFrames: number;

  // Media info
  codecInfo: string;
  resolutionInfo: string;
  fileInfo: FileInfo | null;
  currentFrameData: FrameData | null;

  // Performance
  frameDropCount: number;
  bufferHealth: number;
  rendererKind: 'canvas2d' | 'webgl' | 'webgpu';
}
```

## Rendering Backends

### Canvas2D
- **Compatibility**: Universal browser support
- **Performance**: Good for basic playback
- **Features**: Basic 2D canvas rendering

### WebGL2
- **Compatibility**: Modern browsers
- **Performance**: High-performance hardware acceleration
- **Features**: GPU-accelerated YUV-to-RGB conversion

### WebGPU
- **Compatibility**: Latest browsers
- **Performance**: Best performance and efficiency
- **Features**: Next-gen GPU compute and rendering

## Performance Tips

1. **Use WebGL/WebGPU**: Much faster than Canvas2D for video
2. **Set power preference**: Use `high-performance` for better frame rates
3. **Monitor buffer health**: Check `bufferHealth` in player state
4. **Handle frame drops**: Use `frameDropCount` for performance tuning

## Asset Hosting

The player requires decoder assets to be hosted:

```javascript
// Copy from node_modules after build
cp node_modules/@avplay/decoder/dist/decoder.js public/
cp node_modules/@avplay/decoder/dist/decoder-worker.js public/

// Or specify custom URLs
const player = new AvplayPlayer({
  canvas,
  assets: {
    workerUrl: '/assets/decoder-worker.js',
    decoderUrl: '/assets/decoder.js'
  }
});
```

## Integration with @avplay/react

For React applications, use `@avplay/react` which provides hooks and components built on this core API.