import type { FileInfo, FrameData } from "@avplay/decoder";
import { decoderSingleton } from "./decoder/decoder-singleton";
import { RendererFactory } from "./renderers/factory";
import type {
	IVideoRenderer,
	RendererKind,
	VideoFrameData,
} from "./types/renderers";

export type PlaybackState =
	| "IDLE"
	| "LOADING"
	| "PLAYING"
	| "PAUSED"
	| "SEEKING"
	| "BUFFERING";

export interface AvplayPlayerOptions {
	canvas: HTMLCanvasElement;
	preferredRenderer?: RendererKind;
	powerPreference?: "high-performance" | "low-power";
	assets?: { workerUrl?: string; decoderUrl?: string };
}

export interface AvplayPlayerState {
	codecInfo: string;
	resolutionInfo: string;
	fpsInfo: string;
	frameInfo: string;
	progressPercent: number;
	progressText: string;
	isPlaying: boolean;
	isMuted: boolean;
	subtitlesEnabled: boolean;
	fileInfo: FileInfo | null;
	currentFrameData: FrameData | null;
	currentTime: number;
	currentFrame: number;
	videoDuration: number;
	frameRate: number;
	totalFrames: number;
	playbackState: PlaybackState;
	lastFrameTime: number;
	frameDropCount: number;
	targetFrameTime: number;
	bufferHealth: number;
	rendererKind: RendererKind;
}

export class AvplayPlayer {
	private readonly canvas: HTMLCanvasElement;
	private readonly powerPreference: "high-performance" | "low-power";
	private readonly preferredRenderer: RendererKind;
	private readonly assets:
		| { workerUrl?: string; decoderUrl?: string }
		| undefined;

	private rendererFactory: RendererFactory | null = null;
	private renderer: IVideoRenderer | null = null;
	private rendererKind: RendererKind = "canvas2d";

	private state: AvplayPlayerState;
	private stateSnapshot: AvplayPlayerState;

	// Subscriptions
	private listeners: Set<() => void> = new Set();
	private notifyScheduled = false;

	// Audio control state
	private volumeLevel = 0.7;

	private frameBuffer: FrameData[] = [];
	private readonly MAX_FRAME_BUFFER = 60;
	private readonly MIN_BUFFER_FRAMES = 20;
	private readonly PREFETCH_THRESHOLD = 35;
	private readonly BATCH_DECODE_SIZE = 8;

	private animationId: number | null = null;
	private continuousDecodeInterval: number | null = null;
	private isDecoding = false;
	private decodePromise: Promise<unknown> | null = null;

	// Audio
	private audioContext: AudioContext | null = null;
	private gainNode: GainNode | null = null;
	private audioQueue: { buffer: AudioBuffer; duration: number }[] = [];
	private nextAudioTime = 0;
	private isAudioPlaying = false;

	// Timing
	private videoStartTime = 0;
	private pausedTime = 0;

	constructor(options: AvplayPlayerOptions) {
		this.canvas = options.canvas;
		this.powerPreference = options.powerPreference ?? "high-performance";
		this.preferredRenderer = options.preferredRenderer ?? "webgpu";
		this.assets = options.assets;

		this.state = {
			codecInfo: "--",
			resolutionInfo: "--",
			fpsInfo: "--",
			frameInfo: "0 / 0",
			progressPercent: 0,
			progressText: "0%",
			isPlaying: false,
			isMuted: false,
			subtitlesEnabled: false,
			fileInfo: null,
			currentFrameData: null,
			currentTime: 0,
			currentFrame: 0,
			videoDuration: 0,
			frameRate: 25,
			totalFrames: 0,
			playbackState: "IDLE",
			lastFrameTime: 0,
			frameDropCount: 0,
			targetFrameTime: 0,
			bufferHealth: 100,
			rendererKind: "canvas2d",
		};
		this.stateSnapshot = { ...this.state };
	}

	async initialize(): Promise<void> {
		if (this.assets) decoderSingleton.setAssetUrls(this.assets);
		await decoderSingleton.initializeDecoder();
		this.rendererFactory = new RendererFactory({
			canvas: this.canvas,
			powerPreference: this.powerPreference,
		});
		const result = await this.rendererFactory.createRendererWithFallback(
			this.preferredRenderer,
		);
		this.renderer = result.renderer;
		this.rendererKind = result.actualKind;
		this.state.rendererKind = result.actualKind;

		decoderSingleton.setFrameDecodedCallback(this.handleFrameDecoded);
		// Notify subscribers that initialization completed and renderer is ready
		this.updateUi();
	}

	dispose(): void {
		if (this.animationId) {
			cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
		if (this.continuousDecodeInterval) {
			clearInterval(this.continuousDecodeInterval);
			this.continuousDecodeInterval = null;
		}
		this.audioQueue = [];
		if (this.audioContext) {
			try {
				this.audioContext.close();
			} catch {}
			this.audioContext = null;
		}
		if (this.renderer) {
			this.renderer.dispose();
			this.renderer = null;
		}
		this.rendererFactory = null;
		decoderSingleton.setFrameDecodedCallback(() => {});
	}

	getState(): AvplayPlayerState {
		return this.stateSnapshot;
	}

	/**
	 * Subscribe to state changes. Returns an unsubscribe function.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notifyListeners(): void {
		if (this.notifyScheduled) return;
		this.notifyScheduled = true;
		queueMicrotask(() => {
			this.notifyScheduled = false;
			// Refresh snapshot so consumers get stable identity that changes on updates
			this.stateSnapshot = { ...this.state };
			for (const l of this.listeners) l();
		});
	}

	async loadFile(fileData: Uint8Array): Promise<FileInfo> {
		this.setPlaybackState("LOADING");
		const info = await decoderSingleton.loadFile(fileData);
		this.state.fileInfo = info;
		this.state.codecInfo = info.codecName;
		// Try to extract resolution and fps from the first video track string
		if (info.videoTracks.length > 0) {
			const track = info.videoTracks[0] ?? "";
			const resMatch = track.match(/(\d+)x(\d+)/);
			if (resMatch?.[1] && resMatch[2])
				this.state.resolutionInfo = `${parseInt(resMatch[1], 10)}x${parseInt(resMatch[2], 10)}`;
			const fpsMatch = track.match(/([\d.]+)\s*fps/);
			if (fpsMatch?.[1]) {
				this.state.fpsInfo = fpsMatch[1];
				this.state.frameRate = parseFloat(fpsMatch[1]);
			}
		}
		const fps = this.state.frameRate || 25;
		this.state.videoDuration = info.duration > 0 ? info.duration : 60;
		this.state.totalFrames = Math.floor(this.state.videoDuration * fps);
		this.updateInfoUi(0);
		this.setPlaybackState("IDLE");
		// Immediately notify so UI enables controls after file load
		this.updateUi();
		// Prime and display first frame for poster while staying idle (no state toggles)
		await this.seek(0);
		// Ensure any changes are reflected even if priming produced no visible frames
		this.updateUi();
		return info;
	}

	async play(): Promise<void> {
		if (!decoderSingleton.initialized) return;
		if (
			this.state.playbackState === "PLAYING" ||
			this.state.playbackState === "BUFFERING"
		)
			return;
		this.logStartPlayback();
		this.setPlaybackState("BUFFERING");
		this.state.isPlaying = true;
		// Reflect buffering immediately in UI so controls respond
		this.updateUi();

		this.initAudio();
		this.isAudioPlaying = true;

		// Ensure AudioContext is running when resuming from pause
		if (this.audioContext) {
			try {
				if (this.audioContext.state === "suspended") {
					await this.audioContext.resume();
				}
				this.nextAudioTime = this.audioContext.currentTime + 0.05;
			} catch {}
		}

		try {
			await decoderSingleton.resume();
		} catch {}

		const now = performance.now();
		if (this.state.currentTime === 0) {
			this.state.currentFrame = 0;
			this.videoStartTime = now;
		} else {
			this.videoStartTime = now - this.state.currentTime * 1000;
		}
		this.state.targetFrameTime = 1000 / this.state.frameRate;
		this.state.lastFrameTime = now;

		// Reset buffers conditionally
		if (this.state.currentTime === 0 || this.frameBuffer.length === 0) {
			this.frameBuffer = [];
			this.audioQueue = [];
			this.nextAudioTime = this.audioContext?.currentTime || 0;
		}

		// Prebuffer then start decode loop + render loop
		await this.prebuffer(
			Math.min(this.MIN_BUFFER_FRAMES + 5, this.MAX_FRAME_BUFFER / 2),
		);
		this.startContinuousDecoding();
		if (
			this.state.playbackState === ("BUFFERING" as PlaybackState) &&
			this.frameBuffer.length >= this.MIN_BUFFER_FRAMES
		) {
			this.setPlaybackState("PLAYING");
			this.state.lastFrameTime = performance.now();
			this.processAudioQueue();
			this.renderLoop();
		}
	}

	async pause(): Promise<void> {
		const prev = this.state.playbackState;
		this.setPlaybackState("PAUSED");
		this.state.isPlaying = false;
		this.isAudioPlaying = false;
		if (this.continuousDecodeInterval) {
			clearInterval(this.continuousDecodeInterval);
			this.continuousDecodeInterval = null;
		}
		if (this.animationId) {
			cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}
		if (this.decodePromise) {
			try {
				await Promise.race([
					this.decodePromise,
					new Promise((r) => setTimeout(r, 100)),
				]);
			} catch {}
		}
		try {
			await decoderSingleton.pause();
		} catch {}
		if (this.audioContext && this.audioContext.state === "running") {
			try {
				await this.audioContext.suspend();
			} catch {}
		}
		// Preserve progress position for UI while paused
		this.updateInfoUi(this.state.currentTime);
		this.state.playbackState = "PAUSED";
		if (prev !== "PAUSED") this.updateUi();
	}

	async stop(): Promise<void> {
		await this.pause();
		this.setPlaybackState("IDLE");
		this.state.currentFrame = 0;
		this.state.currentTime = 0;
		this.state.frameDropCount = 0;
		this.frameBuffer = [];
		this.audioQueue = [];
		this.nextAudioTime = 0;
		this.videoStartTime = 0;
		this.state.lastFrameTime = 0;
		// Show first frame as poster while staying idle (no extra state toggles)
		try {
			await decoderSingleton.resume();
			await decoderSingleton.seek(0);
			const frame = await decoderSingleton.decodeFrame();
			if (frame) {
				this.state.currentFrameData = frame;
				await this.displayFrame(frame);
				this.state.currentTime =
					typeof frame.timestamp === "number" ? frame.timestamp : 0;
				this.updateInfoUi(this.state.currentTime);
			}
		} catch {
			if (this.renderer?.isReady()) this.renderer.clear();
		}
		// Keep decoder quiescent after stop
		try {
			await decoderSingleton.pause();
		} catch {}
		this.updateUi();
	}

	async seek(targetTime: number): Promise<void> {
		if (!decoderSingleton.initialized || !this.state.videoDuration) return;
		const wasPlaying =
			this.state.playbackState === "PLAYING" ||
			this.state.playbackState === "BUFFERING";
		const previous = this.state.playbackState;
		this.setPlaybackState("SEEKING");
		if (this.continuousDecodeInterval) {
			clearInterval(this.continuousDecodeInterval);
			this.continuousDecodeInterval = null;
		}
		if (wasPlaying) {
			this.state.isPlaying = false;
			this.isAudioPlaying = false;
			if (this.animationId) {
				cancelAnimationFrame(this.animationId);
				this.animationId = null;
			}
			if (this.audioContext && this.audioContext.state === "running") {
				await this.audioContext.suspend();
			}
		} else if (previous === "PAUSED" || previous === "IDLE") {
			// Ensure decoder processes seek/decode when not actively playing
			await decoderSingleton.resume();
		}

		try {
			this.frameBuffer = [];
			this.audioQueue = [];
			this.isDecoding = false;
			this.decodePromise = null;

			const res = await decoderSingleton.seek(targetTime);
			if (res >= 0) {
				this.state.currentTime = targetTime;
				this.state.currentFrame = Math.floor(targetTime * this.state.frameRate);
				this.state.currentFrameData = null;
				this.state.frameDropCount = 0;
				this.state.bufferHealth = 0;
				this.updateProgress((targetTime / this.state.videoDuration) * 100);

				if (this.audioContext) {
					if (this.audioContext.state === "suspended")
						await this.audioContext.resume();
					this.nextAudioTime = this.audioContext.currentTime + 0.1;
				}

				await this.prebuffer(wasPlaying ? this.MIN_BUFFER_FRAMES : 3);

				const now = performance.now();
				this.videoStartTime = now - targetTime * 1000;
				this.state.lastFrameTime = now;
				this.pausedTime = targetTime;
				this.state.frameDropCount = 0;

				if (wasPlaying) {
					this.isAudioPlaying = true;
					this.state.playbackState = "IDLE";
					this.state.isPlaying = false;
					if (this.audioContext && this.audioContext.state === "suspended")
						await this.audioContext.resume();
					this.nextAudioTime = this.audioContext
						? this.audioContext.currentTime + 0.1
						: 0;
					setTimeout(() => this.play(), 100);
				} else {
					this.state.playbackState = previous === "IDLE" ? "IDLE" : "PAUSED";
					// Ensure a frame is shown immediately when seeking while paused/idle
					let frame = this.frameBuffer.shift() ?? null;
					if (!frame) {
						try {
							const f = await decoderSingleton.decodeFrame();
							frame = f ?? this.frameBuffer.shift() ?? null;
						} catch {}
					}
					if (frame) {
						this.state.currentFrameData = frame;
						await this.displayFrame(frame);
					}
				}
			} else {
				this.state.playbackState = previous;
			}
		} catch {
			this.state.playbackState = previous;
			if (wasPlaying) setTimeout(() => this.play(), 100);
		}
		// If we were not playing before the seek, return decoder to a quiescent state
		if (!wasPlaying && (previous === "PAUSED" || previous === "IDLE")) {
			try {
				await decoderSingleton.pause();
			} catch {}
		}
		this.updateUi();
	}

	async enableSubtitles(enable: boolean): Promise<void> {
		try {
			const res = await decoderSingleton.enableSubtitles(enable);
			if (res === 0) {
				this.state.subtitlesEnabled = enable;
				if (
					this.state.playbackState === "PAUSED" &&
					this.state.currentFrameData
				) {
					try {
						this.frameBuffer = [];
						await decoderSingleton.seek(this.state.currentTime);
						await decoderSingleton.decodeFrame();
						if (this.frameBuffer.length > 0) {
							const frame = this.frameBuffer.shift();
							if (frame) {
								this.state.currentFrameData = frame;
								await this.displayFrame(frame);
							}
						}
					} catch {}
				}
			}
		} catch {}
		this.updateUi();
	}

	async loadExternalSubtitles(
		filename: string,
		bytes: Uint8Array,
	): Promise<void> {
		const wasPaused = this.state.playbackState === "PAUSED";
		try {
			if (wasPaused) await decoderSingleton.resume();
			const res = await decoderSingleton.loadExternalSubtitles(filename, bytes);
			if (res === 0) {
				this.state.subtitlesEnabled = true;
				await decoderSingleton.enableSubtitles(true);
				if (wasPaused) {
					this.frameBuffer = [];
					await decoderSingleton.seek(this.state.currentTime);
					await decoderSingleton.decodeFrame();
					if (this.frameBuffer.length > 0) {
						const frame = this.frameBuffer.shift() ?? null;
						if (frame) {
							this.state.currentFrameData = frame;
							await this.displayFrame(frame);
						}
					}
				}
			}
		} finally {
			if (wasPaused) {
				try {
					await decoderSingleton.pause();
				} catch {}
			}
			this.updateUi();
		}
	}

	async addFont(filename: string, data: Uint8Array): Promise<void> {
		await decoderSingleton.addFont(filename, data);
	}

	async rebuildSubtitleFilter(): Promise<void> {
		await decoderSingleton.rebuildSubtitleFilter();
	}

	async switchRenderer(kind: RendererKind): Promise<RendererKind> {
		if (!this.rendererFactory) return this.rendererKind;
		if (this.renderer) {
			this.renderer.dispose();
			this.renderer = null;
		}
		// Replace canvas to avoid context conflicts
		const oldCanvas = this.canvas;
		const parent = oldCanvas.parentElement;
		if (parent) {
			const newCanvas = document.createElement("canvas");
			newCanvas.id = oldCanvas.id;
			newCanvas.className = oldCanvas.className;
			newCanvas.style.cssText = (oldCanvas as HTMLCanvasElement).style.cssText;
			parent.replaceChild(newCanvas, oldCanvas);
			(this as unknown as { canvas: HTMLCanvasElement }).canvas = newCanvas;
			this.rendererFactory = new RendererFactory({
				canvas: newCanvas,
				powerPreference: this.powerPreference,
			});
		}
		const result = await this.rendererFactory.createRendererWithFallback(kind);
		this.renderer = result.renderer;
		this.rendererKind = result.actualKind;
		this.state.rendererKind = result.actualKind;
		if (this.state.currentFrameData)
			await this.displayFrame(this.state.currentFrameData);
		this.updateUi();
		return result.actualKind;
	}

	async switchVideoTrack(index: number): Promise<void> {
		const wasPlaying = this.state.playbackState === "PLAYING";
		if (wasPlaying) await this.pause();
		this.state.currentFrameData = null;
		this.frameBuffer = [];
		const res = await decoderSingleton.switchVideoTrack(index);
		if (res === 0) {
			try {
				await decoderSingleton.decodeFrame();
				if (this.frameBuffer.length > 0) {
					const frame = this.frameBuffer.shift() ?? null;
					if (frame) {
						this.state.currentFrameData = frame;
						await this.displayFrame(frame);
					}
				}
			} catch {}
		}
		if (wasPlaying) setTimeout(() => this.play(), 50);
		this.updateUi();
	}

	async switchAudioTrack(index: number): Promise<void> {
		const wasPlaying = this.state.isPlaying;
		if (wasPlaying) await this.pause();
		this.audioQueue = [];
		this.nextAudioTime = 0;
		await decoderSingleton.switchAudioTrack(index);
		if (wasPlaying) setTimeout(() => this.play(), 50);
	}

	async switchSubtitleTrack(index: number): Promise<void> {
		const wasPaused = this.state.playbackState === "PAUSED";
		if (wasPaused) await decoderSingleton.resume();
		const res = await decoderSingleton.switchSubtitleTrack(index);
		if (res === 0 && this.state.currentFrameData) {
			this.frameBuffer = [];
			try {
				await decoderSingleton.decodeFrame();
				if (wasPaused && this.frameBuffer.length > 0) {
					const frame = this.frameBuffer.shift() ?? null;
					if (frame) {
						this.state.currentFrameData = frame;
						await this.displayFrame(frame);
					}
				}
			} catch {}
		}
		if (wasPaused) await decoderSingleton.pause();
		this.updateUi();
	}

	async extractTrack(
		trackType: number,
		trackIndex: number,
	): Promise<{ data: Uint8Array; size: number } | null> {
		try {
			return await decoderSingleton.extractTrack(trackType, trackIndex);
		} catch {
			return null;
		}
	}

	async extractAttachment(
		index: number,
	): Promise<{ data: Uint8Array; size: number } | null> {
		try {
			return await decoderSingleton.extractAttachment(index);
		} catch {
			return null;
		}
	}

	// Internal helpers
	private handleFrameDecoded = (data: FrameData) => {
		// Accept frames in all states; decode loops are gated elsewhere.
		if (this.frameBuffer.length < this.MAX_FRAME_BUFFER) {
			this.frameBuffer.push(data);
			this.state.bufferHealth =
				(this.frameBuffer.length / this.MAX_FRAME_BUFFER) * 100;
		}
		if (
			data.audioData &&
			data.audioData.length > 0 &&
			this.audioQueue.length < 40
		) {
			const sr =
				typeof data.audioSampleRate === "number" ? data.audioSampleRate : 48000;
			const ch =
				typeof data.audioChannels === "number" ? data.audioChannels : 2;
			this.scheduleAudioBuffer(data.audioData, sr, ch);
		}
	};

	private initAudio(): void {
		if (!this.audioContext) {
			const w = window as unknown as {
				AudioContext?: typeof AudioContext;
				webkitAudioContext?: typeof AudioContext;
			};
			const AudioCtx: typeof AudioContext | undefined =
				w.AudioContext ?? w.webkitAudioContext;
			if (!AudioCtx) return;
			this.audioContext = new AudioCtx();
			this.gainNode = this.audioContext.createGain();
			this.gainNode.connect(this.audioContext.destination);
			this.gainNode.gain.value = this.state.isMuted ? 0 : 0.7;
		}
	}

	private scheduleAudioBuffer(
		audioData: Float32Array,
		sampleRate: number,
		channels: number,
	) {
		if (!this.audioContext || !audioData) return;
		const samples = Math.floor(audioData.length / Math.max(1, channels));
		const audioBuffer = this.audioContext.createBuffer(
			Math.min(channels, 2),
			samples,
			sampleRate,
		);
		const channelCount = Math.min(channels, 2);
		for (let ch = 0; ch < channelCount; ch++) {
			const channelOut = audioBuffer.getChannelData(ch);
			if (channels === 1) {
				for (let i = 0; i < samples; i++) channelOut[i] = audioData[i] ?? 0;
			} else {
				for (let i = 0; i < samples; i++)
					channelOut[i] = audioData[i * channels + ch] ?? 0;
			}
		}
		this.audioQueue.push({
			buffer: audioBuffer,
			duration: audioBuffer.duration,
		});
	}

	private processAudioQueue() {
		if (!this.audioContext) return;
		if (this.audioQueue.length === 0) return;
		if (!this.isAudioPlaying) return;
		if (this.state.playbackState !== "PLAYING") return;

		const bufferAhead = 1.0;
		const currentTime = this.audioContext.currentTime;
		if (
			this.nextAudioTime < currentTime - 0.1 ||
			this.nextAudioTime > currentTime + 2.0
		) {
			this.nextAudioTime = currentTime + 0.01;
		}
		let scheduled = 0;
		while (
			this.audioQueue.length > 0 &&
			this.nextAudioTime < currentTime + bufferAhead &&
			scheduled < 5
		) {
			const item = this.audioQueue.shift();
			if (!item) break;
			if (!this.state.isMuted && this.gainNode && this.audioContext) {
				try {
					const source = this.audioContext.createBufferSource();
					source.buffer = item.buffer;
					source.connect(this.gainNode);
					const startTime = Math.max(this.nextAudioTime, currentTime + 0.01);
					source.start(startTime);
					scheduled++;
				} catch {}
			}
			this.nextAudioTime += item.duration;
		}
	}

	private async prebuffer(targetBuffer: number): Promise<void> {
		let buffered = this.frameBuffer.length;
		while (
			buffered < targetBuffer &&
			(this.state.playbackState === "BUFFERING" ||
				this.state.playbackState === "SEEKING")
		) {
			try {
				await this.decodeFrames(true);
				buffered = this.frameBuffer.length;
				this.state.bufferHealth = (buffered / this.MAX_FRAME_BUFFER) * 100;
				await new Promise((r) => setTimeout(r, 10));
			} catch {
				break;
			}
		}
	}

	private startContinuousDecoding() {
		if (this.continuousDecodeInterval)
			clearInterval(this.continuousDecodeInterval);
		this.continuousDecodeInterval = window.setInterval(() => {
			if (
				this.state.playbackState === "PLAYING" ||
				this.state.playbackState === "BUFFERING"
			) {
				if (this.frameBuffer.length < this.PREFETCH_THRESHOLD)
					this.decodeFrames(true);
			}
		}, 20);
	}

	private async decodeFrames(forceBatch = false) {
		if (
			this.isDecoding ||
			this.state.playbackState === ("PAUSED" as PlaybackState) ||
			this.state.playbackState === ("IDLE" as PlaybackState)
		) {
			return;
		}
		this.isDecoding = true;
		try {
			const frameBufferSpace = this.MAX_FRAME_BUFFER - this.frameBuffer.length;
			let batchSize = this.BATCH_DECODE_SIZE;
			if (this.frameBuffer.length < this.MIN_BUFFER_FRAMES)
				batchSize = Math.min(6, frameBufferSpace);
			else if (this.frameBuffer.length < this.PREFETCH_THRESHOLD)
				batchSize = Math.min(4, frameBufferSpace);
			else if (forceBatch)
				batchSize = Math.min(this.BATCH_DECODE_SIZE, frameBufferSpace);
			else if (frameBufferSpace <= 2) return;

			for (let i = 0; i < batchSize; i++) {
				if (
					this.state.playbackState === "PAUSED" ||
					this.state.playbackState === "IDLE" ||
					this.frameBuffer.length >= this.MAX_FRAME_BUFFER
				) {
					break;
				}
				try {
					this.decodePromise = decoderSingleton.decodeFrame();
					await this.decodePromise;
					this.decodePromise = null;
				} catch {
					break;
				}
			}
		} finally {
			this.isDecoding = false;
		}
		if (this.state.playbackState === "PLAYING") this.processAudioQueue();
	}

	private async renderLoop() {
		if (
			this.state.playbackState !== "PLAYING" &&
			this.state.playbackState !== "BUFFERING"
		) {
			this.animationId = null;
			return;
		}
		const now = performance.now();
		let elapsed: number;

		if (this.state.playbackState === "BUFFERING") {
			elapsed = this.pausedTime || this.state.currentTime;
			this.state.currentTime = elapsed;
		} else {
			elapsed = (now - this.videoStartTime) / 1000;
			this.state.currentTime = elapsed;
			if (this.frameBuffer.length > 0) {
				const frame = this.frameBuffer[0];
				if (frame && typeof frame.timestamp === "number") {
					const frameTime = frame.timestamp;
					const timeDiff = frameTime - elapsed;
					if (timeDiff <= 0.033) {
						const first = this.frameBuffer.shift();
						if (first) {
							this.state.currentFrameData = first;
							await this.displayFrame(first);
							this.state.lastFrameTime = now;
							this.state.currentFrame++;
						}
						while (
							this.frameBuffer.length > 0 &&
							typeof (this.frameBuffer[0] as FrameData | undefined)
								?.timestamp === "number" &&
							((this.frameBuffer[0] as FrameData).timestamp as number) <
								elapsed - 0.1
						) {
							this.frameBuffer.shift();
							this.state.frameDropCount++;
						}
					}
				} else {
					const frameDelta = now - this.state.lastFrameTime;
					if (frameDelta >= this.state.targetFrameTime * 0.95) {
						const f = this.frameBuffer.shift();
						if (f) {
							this.state.currentFrameData = f;
							await this.displayFrame(f);
							this.state.lastFrameTime = now;
							this.state.currentFrame++;
						}
					}
				}
				this.state.bufferHealth =
					(this.frameBuffer.length / this.MAX_FRAME_BUFFER) * 100;
			} else {
				this.setPlaybackState("BUFFERING");
				this.pausedTime = this.state.currentTime;
			}
		}

		if (this.state.playbackState === "BUFFERING") {
			const hasEnoughFrames = this.frameBuffer.length >= this.MIN_BUFFER_FRAMES;
			const hasEnoughAudio =
				!this.state.fileInfo?.hasAudio || this.audioQueue.length >= 15;
			if (hasEnoughFrames && hasEnoughAudio) {
				const resumeTime = this.pausedTime;
				this.videoStartTime = now - resumeTime * 1000;
				this.state.lastFrameTime = now;
				this.state.currentTime = resumeTime;
				if (this.audioContext) {
					if (this.audioContext?.state === "suspended")
						await this.audioContext.resume();
					this.audioQueue = [];
					if (this.audioContext)
						this.nextAudioTime = this.audioContext.currentTime + 0.05;
				}
				this.setPlaybackState("PLAYING");
			}
		}

		if (this.state.playbackState === "PLAYING") this.processAudioQueue();
		this.updateInfoUi(elapsed ?? this.state.currentTime);
		// Notify listeners every frame; use microtask batching to reduce thrash
		this.updateUi();
		this.animationId = requestAnimationFrame(() => this.renderLoop());
	}

	private async displayFrame(frame: FrameData) {
		if (!this.renderer || !this.renderer.isReady()) return;
		const { width, height, rgbData } = frame;
		if (width === 0 || height === 0) return;
		const frameData: VideoFrameData = { width, height, data: rgbData };
		try {
			this.renderer.renderFrame(frameData);
		} catch {}
	}

	private updateInfoUi(elapsedSeconds: number) {
		const currentMins = Math.floor(elapsedSeconds / 60);
		const currentSecs = Math.floor(elapsedSeconds % 60);
		const totalMins = Math.floor(this.state.videoDuration / 60);
		const totalSecs = Math.floor(this.state.videoDuration % 60);
		this.state.progressText = `${currentMins}:${currentSecs.toString().padStart(2, "0")} / ${totalMins}:${totalSecs.toString().padStart(2, "0")}`;
		if (this.state.videoDuration > 0) {
			const percent = Math.min(
				100,
				(elapsedSeconds / this.state.videoDuration) * 100,
			);
			this.updateProgress(percent);
		}
		if (this.state.currentFrameData) {
			this.state.codecInfo =
				this.state.currentFrameData.codecName || this.state.codecInfo;
			this.state.resolutionInfo = `${this.state.currentFrameData.width}x${this.state.currentFrameData.height}`;
			this.state.fpsInfo = this.state.frameRate.toString();
			this.state.frameInfo = `${this.state.currentFrame} / ${this.state.totalFrames}`;
		}
	}

	private updateProgress(percent: number) {
		this.state.progressPercent = percent;
	}

	private setPlaybackState(s: PlaybackState) {
		this.state.playbackState = s;
	}

	private updateUi() {
		this.notifyListeners();
	}

	private logStartPlayback() {
		// no-op placeholder for consistency with demo logging
	}

	// Volume/mute controls
	setVolume(volume: number): void {
		this.volumeLevel = Math.max(0, Math.min(1, volume));
		this.initAudio();
		if (this.gainNode)
			this.gainNode.gain.value = this.state.isMuted ? 0 : this.volumeLevel;
		this.updateUi();
	}

	getVolume(): number {
		return this.volumeLevel;
	}

	setMute(muted: boolean): void {
		this.state.isMuted = muted;
		this.initAudio();
		if (this.gainNode) this.gainNode.gain.value = muted ? 0 : this.volumeLevel;
		this.updateUi();
	}

	getMute(): boolean {
		return this.state.isMuted;
	}
}
