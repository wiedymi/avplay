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
