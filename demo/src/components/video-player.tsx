import React, { useRef } from "react";
import { useAvplay } from "@avplay/react";
import { TrackList } from "./track-list";

// Math utilities
declare global {
	interface Math {
		clamp(value: number, min: number, max: number): number;
	}
}

if (!Math.clamp) {
	Math.clamp = function (value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	};
}

enum PlaybackState {
	IDLE = "IDLE",
	LOADING = "LOADING",
	PLAYING = "PLAYING",
	PAUSED = "PAUSED",
	SEEKING = "SEEKING",
	BUFFERING = "BUFFERING",
}

export const VideoPlayer: React.FC = () => {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const subtitleInputRef = useRef<HTMLInputElement>(null);
	const fontInputRef = useRef<HTMLInputElement>(null);

	const {
		canvasRef,
		ready,
		state,
		play,
		pause,
		stop,
		seek,
		loadFile,
		enableSubtitles,
		loadExternalSubtitles,
		addFont,
		rebuildSubtitleFilter,
		switchRenderer,
		switchVideoTrack,
		switchAudioTrack,
		switchSubtitleTrack,
		extractTrack,
		extractAttachment,
	} = useAvplay();

	const onLoadVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0];
		if (!f) return;
		const bytes = new Uint8Array(await f.arrayBuffer());
		await stop?.();
		await loadFile?.(bytes);
		
	};

	const onLoadSubtitles = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0];
		if (!f) return;
		const name = f.name;
		const bytes = new Uint8Array(await f.arrayBuffer());
		await loadExternalSubtitles?.(name, bytes);
		if (subtitleInputRef.current) subtitleInputRef.current.value = "";
		
	};

	const onAddFonts = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files || files.length === 0) return;
		for (let i = 0; i < files.length; i++) {
			const f = files.item(i);
			if (!f) continue;
			const bytes = new Uint8Array(await f.arrayBuffer());
			await addFont?.(f.name, bytes);
		}
		await rebuildSubtitleFilter?.();
			if (fontInputRef.current) fontInputRef.current.value = "";
		
	};

	const onSeek = async (e: React.MouseEvent<HTMLDivElement>) => {
		if (!state?.videoDuration) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const clickX = e.clientX - rect.left;
		const progress = Math.clamp(clickX / rect.width, 0, 1);
		await seek?.(progress * state.videoDuration);
		
	};

	const generateTestPattern = () => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		canvas.width = 640;
		canvas.height = 480;
		const imageData = ctx.createImageData(640, 480);
		for (let y = 0; y < 480; y++) {
			for (let x = 0; x < 640; x++) {
				const i = (y * 640 + x) * 4;
				const checker = (Math.floor(x / 32) ^ Math.floor(y / 32)) & 1;
				const value = checker ? 255 : 0;
				imageData.data[i] = value;
				imageData.data[i + 1] = value;
				imageData.data[i + 2] = value;
				imageData.data[i + 3] = 255;
			}
		}
		ctx.putImageData(imageData, 0, 0);
	};

	return (
		<div className="video-player">
			<div className="header">
				<h1>AVPLAY</h1>
				<div className="status" id="status">
					<span id="status-text">
						{state?.fileInfo ? "READY" : ready ? "INITIALIZED" : "INITIALIZING"}
					</span>
					<span className="blink">_</span>
				</div>
			</div>

			<div className="info-panel">
				<div className="info-grid">
					<div className="info-item">
						<div className="label">Codec</div>
						<div className="value" id="codec-info">{state?.codecInfo ?? "--"}</div>
					</div>
					<div className="info-item">
						<div className="label">Resolution</div>
						<div className="value" id="resolution-info">{state?.resolutionInfo ?? "--"}</div>
					</div>
					<div className="info-item">
						<div className="label">FPS</div>
						<div className="value" id="fps-info">{state?.fpsInfo ?? "--"}</div>
					</div>
					<div className="info-item">
						<div className="label">Frames</div>
						<div className="value" id="frame-info">{state?.frameInfo ?? "0 / 0"}</div>
					</div>
					<div className="info-item">
						<div className="label">State</div>
						<div className="value">{state?.playbackState ?? PlaybackState.IDLE}</div>
					</div>
					<div className="info-item">
						<div className="label">Buffer</div>
						<div
							className="value"
							style={{
								color: (state?.bufferHealth ?? 0) > 50 ? "#0f0" : (state?.bufferHealth ?? 0) > 25 ? "#ff0" : "#f00",
							}}
						>
							{Math.round(state?.bufferHealth ?? 0)}%
						</div>
					</div>
				</div>
			</div>

			<div className="player-container">
				<canvas ref={canvasRef} id="video-canvas" />
			</div>

			<div className="progress-bar" id="progress-bar" onClick={onSeek}>
				<div className="progress-fill" id="progress-fill" style={{ width: `${state?.progressPercent ?? 0}%` }} />
				<div className="progress-text" id="progress-text">{state?.progressText ?? "0%"}</div>
			</div>

			<div className="controls">
				<div className="control-row">
					<input
						type="file"
						id="file-input"
						ref={fileInputRef}
						accept="video/*,audio/*,.mkv,.avi,.mp4,.mov,.wmv,.flv,.webm,.m4v,.3gp,.ts,.m2ts,.mts,.vob,.ogv,.rm,.rmvb,.asf,.divx,.xvid,.f4v,.m4a,.aac,.mp3,.flac,.ogg,.wav,.wma,.ac3,.dts,.ape,.opus,.aiff,.au,.ra,.m4b,.3ga,.amr,.awb,.gsm,.spx,.tta,.wv,.mka,.mks,.webma"
						onChange={onLoadVideo}
						style={{ display: "none" }}
					/>
					<label htmlFor="file-input" className="file-label">LOAD VIDEO</label>
					<input
						type="file"
						id="subtitle-input"
						ref={subtitleInputRef}
						accept=".ass,.ssa,.srt,.vtt,.sub,.sup,.txt"
						onChange={onLoadSubtitles}
						style={{ display: "none" }}
					/>
					<label htmlFor="subtitle-input" className="file-label" style={{ marginLeft: "10px" }}>LOAD SUBTITLES</label>
					<input
						type="file"
						id="font-input"
						ref={fontInputRef}
						accept=".ttf,.otf,.ttc,.woff,.woff2"
						multiple
						onChange={onAddFonts}
						style={{ display: "none" }}
					/>
					<label htmlFor="font-input" className="file-label" style={{ marginLeft: "10px" }}>ADD FONTS</label>
					<select onChange={(e) => switchRenderer?.(e.target.value as any)} style={{ marginLeft: "10px", padding: "5px" }}>
						{["webgpu", "webgl", "canvas2d"].map((r) => (
							<option key={r} value={r}>{r.toUpperCase()}</option>
						))}
					</select>
					<button
						id="play-pause-btn"
						disabled={!state?.fileInfo || state?.playbackState === PlaybackState.LOADING}
						onClick={async () => {
							if (state?.playbackState === PlaybackState.PLAYING || state?.playbackState === PlaybackState.BUFFERING) {
								await pause?.();
							} else if (state?.playbackState === PlaybackState.PAUSED || state?.playbackState === PlaybackState.IDLE) {
								await play?.();
							}
							
						}}
					>
						{state?.playbackState === PlaybackState.PLAYING ? "PAUSE" : state?.playbackState === PlaybackState.BUFFERING ? "BUFFERING" : "PLAY"}
					</button>
					<button id="stop-btn" onClick={async () => { await stop?.();  }}>STOP</button>
					<button
						id="subtitle-btn"
						disabled={!state?.fileInfo || (state?.fileInfo?.trackCounts.subtitle ?? 0) === 0}
						onClick={async () => { await enableSubtitles?.(!(state?.subtitlesEnabled));  }}
					>
						{state?.subtitlesEnabled ? "SUBTITLES ON" : "SUBTITLES OFF"}
					</button>
				</div>

				<TrackList
					fileInfo={state?.fileInfo ?? null}
					onVideoTrackSelect={async (index) => { await switchVideoTrack?.(index);  }}
					onAudioTrackSelect={async (index) => { await switchAudioTrack?.(index);  }}
					onSubtitleTrackSelect={async (index) => { await switchSubtitleTrack?.(index);  }}
					onExtractTrack={async (trackType, index) => {
						const map = { video: 0, audio: 1, subtitle: 2 } as const;
						const res = await extractTrack?.(map[trackType], index);
						if (res && res.data) {
							const blob = new Blob([res.data.slice().buffer as ArrayBuffer]);
								const url = URL.createObjectURL(blob);
								const a = document.createElement("a");
								a.href = url;
							a.download = `${trackType}_track_${index + 1}`;
								document.body.appendChild(a);
								a.click();
								document.body.removeChild(a);
								URL.revokeObjectURL(url);
						}
					}}
					onDownloadAttachment={async (index) => {
						const res = await extractAttachment?.(index);
						if (res && res.data) {
							const blob = new Blob([res.data.slice().buffer as ArrayBuffer]);
								const url = URL.createObjectURL(blob);
								const a = document.createElement("a");
								a.href = url;
							a.download = `attachment_${index + 1}`;
								document.body.appendChild(a);
								a.click();
								document.body.removeChild(a);
								URL.revokeObjectURL(url);
						}
					}}
				/>
			</div>

			<div className="codec-list">
				<h2>SUPPORTED CODECS</h2>
				<div className="codec-grid" id="codec-grid">
					{["h264","hevc","vp8","vp9","av1","mpeg4","mpeg2video","aac","mp3","opus","vorbis","ac3"].map((codec) => (
						<div key={codec} className={`codec-item ${state?.codecInfo?.toLowerCase() === codec ? "active" : ""}`}>{codec}</div>
					))}
				</div>
			</div>

			<div className="controls" style={{ marginTop: "10px" }}>
				<button id="test-btn" onClick={generateTestPattern}>TEST PATTERN</button>
			</div>

		</div>
	);
}


