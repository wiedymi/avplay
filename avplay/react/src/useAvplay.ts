import type { FileInfo, RendererKind, TrackExtractionResult } from "@avplay/core";
import { AvplayPlayer } from "@avplay/core";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

type Options = {
	renderer?: RendererKind;
	assets?: { workerUrl?: string; decoderUrl?: string };
};

type PlaybackStateStr =
	| "IDLE"
	| "LOADING"
	| "PLAYING"
	| "PAUSED"
	| "SEEKING"
	| "BUFFERING";

export type AvplayStatePublic = {
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
	currentTime: number;
	currentFrame: number;
	videoDuration: number;
	frameRate: number;
	totalFrames: number;
	playbackState: PlaybackStateStr;
	bufferHealth?: number;
};

export interface UseAvplayApi {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	ready: boolean;
	state: AvplayStatePublic | undefined;
	play: () => Promise<void>;
	pause: () => Promise<void>;
	stop: () => Promise<void>;
	seek: (t: number) => Promise<void>;
	loadFile: (bytes: Uint8Array) => Promise<void>;
	enableSubtitles: (enable: boolean) => Promise<void>;
	loadExternalSubtitles: (name: string, bytes: Uint8Array) => Promise<void>;
	addFont: (name: string, bytes: Uint8Array) => Promise<void>;
	rebuildSubtitleFilter: () => Promise<void>;
	switchRenderer: (k: RendererKind) => Promise<void>;
	switchVideoTrack: (i: number) => Promise<void>;
	switchAudioTrack: (i: number) => Promise<void>;
	switchSubtitleTrack: (i: number) => Promise<void>;
	extractTrack: (
		tt: number,
		ti: number,
	) => Promise<TrackExtractionResult | null | undefined>;
	extractAttachment: (
		i: number,
	) => Promise<{ data: Uint8Array; size: number } | null | undefined>;
	setVolume: (volume: number) => Promise<void>;
	setMute: (muted: boolean) => Promise<void>;
	getVolume: () => number;
	getMute: () => boolean;
}

export function useAvplay(options: Options = {}): UseAvplayApi {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const playerRef = useRef<AvplayPlayer | null>(null);
	const [ready, setReady] = useState(false);

	const subscribe = useCallback((onStoreChange: () => void) => {
		const p = playerRef.current;
		if (!p) return () => {};
		return p.subscribe(onStoreChange);
	}, []);

	const getSnapshot = useCallback(() => {
		const p = playerRef.current;
		return (p?.getState() as unknown as AvplayStatePublic) ?? undefined;
	}, []);

	// Extract primitives so the effect does not depend on inline object identity
	const preferredRenderer = options.renderer ?? "webgpu";
	const workerUrl = options.assets?.workerUrl;
	const decoderUrl = options.assets?.decoderUrl;

	useEffect(() => {
		let mounted = true;
		const init = async () => {
			if (!canvasRef.current) return;
			if (playerRef.current) return; // guard against re-init

			const p = new AvplayPlayer({
				canvas: canvasRef.current,
				preferredRenderer,
				powerPreference: "high-performance",
				assets: workerUrl || decoderUrl ? { workerUrl, decoderUrl } : undefined,
			});
			playerRef.current = p;
			console.log("start initialize");
			await p.initialize();
			console.log("end initialize");
			if (mounted) setReady(true);
		};
		init().catch(() => setReady(false));
		return () => {
			mounted = false;
			playerRef.current?.dispose();
			playerRef.current = null;
		};
	}, [preferredRenderer, workerUrl, decoderUrl]);

	const state = useSyncExternalStore(subscribe, getSnapshot);

	return {
		canvasRef,
		ready,
		state,
		play: async () => {
			await playerRef.current?.play();
		},
		pause: async () => {
			await playerRef.current?.pause();
		},
		stop: async () => {
			await playerRef.current?.stop();
		},
		seek: async (t: number) => {
			await playerRef.current?.seek(t);
		},
		loadFile: async (bytes: Uint8Array) => {
			await playerRef.current?.loadFile(bytes);
		},
		enableSubtitles: async (enable: boolean) =>
			await playerRef.current?.enableSubtitles(enable),
		loadExternalSubtitles: async (name: string, bytes: Uint8Array) =>
			await playerRef.current?.loadExternalSubtitles(name, bytes),
		addFont: async (name: string, bytes: Uint8Array) => {
			await playerRef.current?.addFont(name, bytes);
		},
		rebuildSubtitleFilter: async () => {
			await playerRef.current?.rebuildSubtitleFilter();
		},
		switchRenderer: async (k: RendererKind) => {
			await playerRef.current?.switchRenderer(k);
		},
		switchVideoTrack: async (i: number) =>
			await playerRef.current?.switchVideoTrack(i),
		switchAudioTrack: async (i: number) =>
			await playerRef.current?.switchAudioTrack(i),
		switchSubtitleTrack: async (i: number) =>
			await playerRef.current?.switchSubtitleTrack(i),
		extractTrack: async (tt: number, ti: number) =>
			await playerRef.current?.extractTrack(tt, ti),
		extractAttachment: async (i: number) =>
			await playerRef.current?.extractAttachment(i),
		setVolume: async (volume: number) => {
			playerRef.current?.setVolume(volume);
		},
		setMute: async (muted: boolean) => {
			playerRef.current?.setMute(muted);
		},
		getVolume: () => playerRef.current?.getVolume() ?? 0,
		getMute: () => playerRef.current?.getMute() ?? false,
	} as const;
}
