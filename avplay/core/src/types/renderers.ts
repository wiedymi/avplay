export type RendererKind = "canvas2d" | "webgl" | "webgpu";

export interface IVideoRenderer {
	isReady(): boolean;
	renderFrame(frame: VideoFrameData): boolean;
	clear(): void;
	dispose(): void;
}

export interface VideoFrameData {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}
