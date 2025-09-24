export interface WebGLRendererOptions {
	canvas: HTMLCanvasElement;
	preserveDrawingBuffer?: boolean;
	antialias?: boolean;
	alpha?: boolean;
	powerPreference?: "high-performance" | "low-power" | "default";
}

export interface ViewportMode {
	mode: "fit" | "fill" | "stretch" | "original";
}

export interface WebGLResources {
	gl: WebGLRenderingContext | null;
	program: WebGLProgram | null;
	texture: WebGLTexture | null;
	vertexBuffer: WebGLBuffer | null;
	texCoordBuffer: WebGLBuffer | null;
	positionLocation: number;
	texCoordLocation: number;
	textureLocation: WebGLUniformLocation | null;
}

export interface RenderStats {
	fps: number;
	frameTime: number;
	droppedFrames: number;
	textureUploads: number;
}
