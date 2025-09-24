import type { IVideoRenderer, VideoFrameData } from "../types/renderers";

export interface Canvas2DRendererOptions {
	canvas: HTMLCanvasElement;
}

export class Canvas2DRenderer implements IVideoRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D | null = null;
	private isInitialized = false;

	constructor(options: Canvas2DRendererOptions) {
		this.canvas = options.canvas;
		this.initialize();
	}

	private initialize(): boolean {
		try {
			this.ctx = this.canvas.getContext("2d");
			if (!this.ctx) {
				return false;
			}

			this.ctx.imageSmoothingEnabled = true;
			this.ctx.imageSmoothingQuality = "high";

			this.isInitialized = true;
			return true;
		} catch {
			return false;
		}
	}

	public isReady(): boolean {
		return this.isInitialized && this.ctx !== null;
	}

	public renderFrame(frame: VideoFrameData): boolean {
		if (!this.isReady() || !this.ctx) {
			return false;
		}

		try {
			const { width, height, data } = frame;
			if (width === 0 || height === 0) {
				return false;
			}

			const dpr = window.devicePixelRatio || 1;
			const displayWidth = this.canvas.clientWidth;
			const displayHeight = this.canvas.clientHeight;
			const canvasWidth = displayWidth * dpr;
			const canvasHeight = displayHeight * dpr;

			this.canvas.width = canvasWidth;
			this.canvas.height = canvasHeight;

			const imageData = new ImageData(data.slice(), width, height);

			const scale = Math.min(canvasWidth / width, canvasHeight / height);
			const destW = Math.floor(width * scale);
			const destH = Math.floor(height * scale);
			const dx = Math.floor((canvasWidth - destW) / 2);
			const dy = Math.floor((canvasHeight - destH) / 2);

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = width;
			tempCanvas.height = height;
			const tempCtx = tempCanvas.getContext("2d");

			if (tempCtx) {
				tempCtx.putImageData(imageData, 0, 0);
				this.ctx.clearRect(0, 0, canvasWidth, canvasHeight);
				this.ctx.drawImage(
					tempCanvas,
					0,
					0,
					width,
					height,
					dx,
					dy,
					destW,
					destH,
				);
			} else {
				this.canvas.width = width;
				this.canvas.height = height;
				this.ctx.putImageData(imageData, 0, 0);
			}

			return true;
		} catch {
			return false;
		}
	}

	public clear(): void {
		if (!this.isReady() || !this.ctx) {
			return;
		}
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
	}

	public dispose(): void {
		this.ctx = null;
		this.isInitialized = false;
	}
}
