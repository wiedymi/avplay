# @avplay/react

React bindings for avplay media player, providing hooks and components for easy integration.

## Overview

This package provides:
- `useAvplay` hook for React integration
- State management with `useSyncExternalStore`
- Automatic cleanup and lifecycle management
- TypeScript support with full type safety

## Installation

```bash
bun add @avplay/react
# or
npm install @avplay/react
```

## Usage

### Basic Usage

```tsx
import React from 'react';
import { useAvplay } from '@avplay/react';

function VideoPlayer() {
  const {
    canvasRef,
    ready,
    state,
    play,
    pause,
    loadFile
  } = useAvplay({
    renderer: 'webgl',
    assets: {
      workerUrl: '/decoder-worker.js',
      decoderUrl: '/decoder.js'
    }
  });

  const handleFileSelect = async (event) => {
    const file = event.target.files[0];
    if (file) {
      const buffer = new Uint8Array(await file.arrayBuffer());
      await loadFile(buffer);
    }
  };

  return (
    <div>
      <canvas ref={canvasRef} width={800} height={600} />

      <div>
        <input type="file" onChange={handleFileSelect} accept="video/*" />

        {ready && (
          <div>
            <button onClick={play} disabled={state?.isPlaying}>
              Play
            </button>
            <button onClick={pause} disabled={!state?.isPlaying}>
              Pause
            </button>

            {state && (
              <div>
                <p>Duration: {state.videoDuration.toFixed(2)}s</p>
                <p>Current: {state.currentTime.toFixed(2)}s</p>
                <p>Progress: {state.progressPercent.toFixed(1)}%</p>
                <p>Resolution: {state.resolutionInfo}</p>
                <p>Codec: {state.codecInfo}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

### Advanced Usage

```tsx
import React, { useCallback } from 'react';
import { useAvplay, RendererKind } from '@avplay/react';

function AdvancedPlayer() {
  const {
    canvasRef,
    ready,
    state,
    play,
    pause,
    seek,
    switchVideoTrack,
    switchAudioTrack,
    enableSubtitles,
    loadExternalSubtitles,
    addFont,
    setVolume,
    setMute
  } = useAvplay({
    renderer: 'webgpu', // Best performance
    assets: {
      workerUrl: '/assets/decoder-worker.js',
      decoderUrl: '/assets/decoder.js'
    }
  });

  const handleSeek = useCallback(async (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const progress = x / rect.width;
    const time = progress * (state?.videoDuration || 0);
    await seek(time);
  }, [seek, state?.videoDuration]);

  const handleTrackSwitch = useCallback(async (trackIndex: number) => {
    await switchVideoTrack(trackIndex);
  }, [switchVideoTrack]);

  const handleSubtitleFile = useCallback(async (event) => {
    const file = event.target.files[0];
    if (file) {
      const buffer = new Uint8Array(await file.arrayBuffer());
      await loadExternalSubtitles(file.name, buffer);
      await enableSubtitles(true);
    }
  }, [loadExternalSubtitles, enableSubtitles]);

  return (
    <div className="player-container">
      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        style={{ width: '100%', height: 'auto' }}
      />

      {ready && state && (
        <div className="controls">
          {/* Progress bar */}
          <div
            className="progress-bar"
            onClick={handleSeek}
            style={{
              width: '100%',
              height: '8px',
              background: '#ddd',
              cursor: 'pointer'
            }}
          >
            <div
              style={{
                width: `${state.progressPercent}%`,
                height: '100%',
                background: '#007bff'
              }}
            />
          </div>

          {/* Playback controls */}
          <div className="playback-controls">
            <button onClick={play} disabled={state.isPlaying}>▶️</button>
            <button onClick={pause} disabled={!state.isPlaying}>⏸️</button>
            <span>{state.currentTime.toFixed(1)}s / {state.videoDuration.toFixed(1)}s</span>
          </div>

          {/* Track selection */}
          {state.fileInfo && (
            <div className="track-controls">
              <select onChange={(e) => handleTrackSwitch(parseInt(e.target.value))}>
                {state.fileInfo.videoTracks.map((track, i) => (
                  <option key={i} value={i}>Video Track {i + 1}: {track}</option>
                ))}
              </select>

              <select onChange={(e) => switchAudioTrack(parseInt(e.target.value))}>
                {state.fileInfo.audioTracks.map((track, i) => (
                  <option key={i} value={i}>Audio Track {i + 1}: {track}</option>
                ))}
              </select>
            </div>
          )}

          {/* Volume control */}
          <div className="volume-controls">
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              onChange={(e) => setVolume(parseFloat(e.target.value))}
            />
            <button onClick={() => setMute(!state.isMuted)}>
              {state.isMuted ? '🔇' : '🔊'}
            </button>
          </div>

          {/* Subtitle controls */}
          <div className="subtitle-controls">
            <input
              type="file"
              accept=".srt,.ass,.vtt"
              onChange={handleSubtitleFile}
            />
            <button onClick={() => enableSubtitles(!state.subtitlesEnabled)}>
              Subtitles: {state.subtitlesEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

## API Reference

### useAvplay Hook

```typescript
function useAvplay(options?: UseAvplayOptions): UseAvplayApi
```

#### Options

```typescript
interface UseAvplayOptions {
  renderer?: 'canvas2d' | 'webgl' | 'webgpu'; // Default: 'webgpu'
  assets?: {
    workerUrl?: string; // Default: '/decoder-worker.js'
    decoderUrl?: string; // Default: '/decoder.js'
  };
}
```

#### Return Value

```typescript
interface UseAvplayApi {
  // React refs
  canvasRef: React.RefObject<HTMLCanvasElement>;

  // State
  ready: boolean;
  state: AvplayState | undefined;

  // Playback controls
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(timeSeconds: number): Promise<void>;

  // Media loading
  loadFile(buffer: Uint8Array): Promise<void>;

  // Track switching
  switchVideoTrack(index: number): Promise<void>;
  switchAudioTrack(index: number): Promise<void>;
  switchSubtitleTrack(index: number): Promise<void>;

  // Subtitle support
  enableSubtitles(enable: boolean): Promise<void>;
  loadExternalSubtitles(filename: string, buffer: Uint8Array): Promise<void>;
  addFont(filename: string, buffer: Uint8Array): Promise<void>;
  rebuildSubtitleFilter(): Promise<void>;

  // Audio controls
  setVolume(volume: number): Promise<void>; // 0-1
  setMute(muted: boolean): Promise<void>;
  getVolume(): number;
  getMute(): boolean;

  // Advanced
  switchRenderer(renderer: RendererKind): Promise<void>;
  extractTrack(trackType: number, trackIndex: number): Promise<ExtractResult>;
  extractAttachment(index: number): Promise<ExtractResult>;
}
```

### Player State

```typescript
interface AvplayState {
  // Playback status
  playbackState: 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'SEEKING' | 'BUFFERING';
  isPlaying: boolean;
  isMuted: boolean;
  subtitlesEnabled: boolean;

  // Timing information
  currentTime: number;
  videoDuration: number;
  progressPercent: number;
  progressText: string;

  // Frame information
  currentFrame: number;
  frameRate: number;
  totalFrames: number;

  // Media information
  codecInfo: string;
  resolutionInfo: string;
  fpsInfo: string;
  frameInfo: string;
  fileInfo: FileInfo | null;

  // Performance
  bufferHealth?: number;
}
```

## Best Practices

### 1. Canvas Sizing

```tsx
// Responsive canvas
<canvas
  ref={canvasRef}
  width={1920}  // Internal resolution
  height={1080}
  style={{
    width: '100%',      // Display size
    height: 'auto',
    maxWidth: '800px'
  }}
/>
```

### 2. Error Handling

```tsx
const [error, setError] = useState<string | null>(null);

const handleLoadFile = async (buffer: Uint8Array) => {
  try {
    setError(null);
    await loadFile(buffer);
  } catch (err) {
    setError(err.message);
  }
};
```

### 3. Performance Optimization

```tsx
// Use WebGPU for best performance
const player = useAvplay({
  renderer: 'webgpu', // Falls back to webgl, then canvas2d
});

// Monitor performance
useEffect(() => {
  if (state?.bufferHealth !== undefined && state.bufferHealth < 0.3) {
    console.warn('Low buffer health:', state.bufferHealth);
  }
}, [state?.bufferHealth]);
```

### 4. Asset Management

```tsx
// Production asset paths
const player = useAvplay({
  assets: {
    workerUrl: process.env.NODE_ENV === 'production'
      ? '/assets/decoder-worker.js'
      : '/decoder-worker.js',
    decoderUrl: process.env.NODE_ENV === 'production'
      ? '/assets/decoder.js'
      : '/decoder.js'
  }
});
```

## Integration with Next.js

```tsx
'use client';

import dynamic from 'next/dynamic';

// Dynamically import to avoid SSR issues
const VideoPlayer = dynamic(() => import('./VideoPlayer'), {
  ssr: false,
  loading: () => <p>Loading player...</p>
});

export default function Page() {
  return <VideoPlayer />;
}
```