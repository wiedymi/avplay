export interface DecoderMessage {
	type: string;
	data?: unknown;
	id?: number;
	error?: string;
}

// Forward decoder types from the dedicated decoder package
export type { FileInfo, FrameData } from "@avplay/decoder";

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

export interface TrackExtractionResult extends ExtractionResult {
	format: string;
	extension: string;
	mimeType: string;
	filename: string;
}
