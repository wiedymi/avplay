export interface DecoderMessage {
	type: string;
	data?: unknown;
	id?: number;
	error?: string;
}

export interface FrameData {
	width: number;
	height: number;
	rgbData: Uint8ClampedArray;
	codecName?: string;
	audioData?: Float32Array;
	audioSampleRate?: number;
	audioChannels?: number;
	timestamp?: number;
}

export interface FileInfo {
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

export interface TrackSwitchData {
	trackType: "video" | "audio" | "subtitle";
	trackIndex: number;
}

export interface TrackExtractionData {
	trackType: "video" | "audio" | "subtitle";
	trackIndex: number;
}

export interface SubtitleRenderResult {
	width: number;
	height: number;
	bitmapData: Uint8ClampedArray;
}

export interface ExtractionResult {
	data: Uint8Array;
	size: number;
}
