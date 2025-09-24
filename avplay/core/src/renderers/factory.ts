import type { IVideoRenderer, RendererKind } from "../types/renderers";
import { Canvas2DRenderer } from "./canvas2d";
import { WebGLVideoRenderer } from "./webgl2";
import { WebGPURenderer } from "./webgpu";

export interface RendererFactoryOptions {
	canvas: HTMLCanvasElement;
	powerPreference?: "high-performance" | "low-power";
}

export class RendererFactory {
	private canvas: HTMLCanvasElement;
	private powerPreference: "high-performance" | "low-power";

	constructor(options: RendererFactoryOptions) {
		this.canvas = options.canvas;
		this.powerPreference = options.powerPreference || "high-performance";
	}

	public async createRenderer(
		kind: RendererKind,
	): Promise<IVideoRenderer | null> {
		try {
			switch (kind) {
				case "webgpu":
					return await this.createWebGPURenderer();
				case "webgl":
					return this.createWebGLRenderer();
				default:
					return this.createCanvas2DRenderer();
			}
		} catch {
			return null;
		}
	}

	public async createRendererWithFallback(
		preferredKind: RendererKind,
	): Promise<{ renderer: IVideoRenderer; actualKind: RendererKind }> {
		const fallbackOrder: RendererKind[] = [preferredKind, "webgl", "canvas2d"];
		for (const kind of fallbackOrder) {
			const renderer = await this.createRenderer(kind);
			if (renderer?.isReady()) {
				return { renderer, actualKind: kind };
			}
		}
		throw new Error("Failed to create any renderer");
	}

	private async createWebGPURenderer(): Promise<IVideoRenderer | null> {
		if (!navigator.gpu) return null;
		const renderer = new WebGPURenderer({
			canvas: this.canvas,
			powerPreference: this.powerPreference,
		});
		for (let i = 0; i < 10; i++) {
			if (renderer.isReady()) return renderer;
			await new Promise((r) => setTimeout(r, 30));
		}
		return renderer.isReady() ? renderer : null;
	}

	private createWebGLRenderer(): IVideoRenderer | null {
		try {
			const renderer = new WebGLVideoRenderer({
				canvas: this.canvas,
				powerPreference: this.powerPreference,
				preserveDrawingBuffer: false,
				antialias: false,
				alpha: false,
			});
			return renderer.isReady() ? renderer : null;
		} catch {
			return null;
		}
	}

	private createCanvas2DRenderer(): IVideoRenderer {
		return new Canvas2DRenderer({ canvas: this.canvas });
	}

	public static getAvailableRenderers(): RendererKind[] {
		const available: RendererKind[] = ["canvas2d"];
		try {
			const canvas = document.createElement("canvas");
			const gl =
				canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
			if (gl) available.push("webgl");
		} catch {}
		if ((navigator as Navigator & { gpu?: unknown }).gpu)
			available.push("webgpu");
		return available;
	}

	public static getRendererDisplayName(kind: RendererKind): string {
		switch (kind) {
			case "canvas2d":
				return "Canvas2D";
			case "webgl":
				return "WebGL";
			case "webgpu":
				return "WebGPU";
			default:
				return "Unknown";
		}
	}
}
