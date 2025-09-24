import type { IVideoRenderer, VideoFrameData } from "../types/renderers";

export interface WebGPURendererOptions {
	canvas: HTMLCanvasElement;
	powerPreference?: "high-performance" | "low-power";
}

export class WebGPURenderer implements IVideoRenderer {
	private canvas: HTMLCanvasElement;
	private device: GPUDevice | null = null;
	private context: GPUCanvasContext | null = null;
	private pipeline: GPURenderPipeline | null = null;
	private texture: GPUTexture | null = null;
	private sampler: GPUSampler | null = null;
	private bindGroup: GPUBindGroup | null = null;
	private vertexBuffer: GPUBuffer | null = null;
	private isInitialized = false;
	private textureWidth = 0;
	private textureHeight = 0;

	private readonly vertexShaderSource = `
    struct VSOut {
      @builtin(position) pos : vec4f,
      @location(0) uv : vec2f,
    };

    @vertex
    fn vs_main(@location(0) in_pos: vec2f, @location(1) in_uv: vec2f) -> VSOut {
      var out: VSOut;
      out.pos = vec4f(in_pos, 0.0, 1.0);
      out.uv = in_uv;
      return out;
    }
  `;

	private readonly fragmentShaderSource = `
    @group(0) @binding(0) var texture_sampler: sampler;
    @group(0) @binding(1) var texture_view: texture_2d<f32>;

    @fragment
    fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      return textureSample(texture_view, texture_sampler, uv);
    }
  `;

	constructor(options: WebGPURendererOptions) {
		this.canvas = options.canvas;
		this.initialize(options).catch(() => {});
	}

	private async initialize(options: WebGPURendererOptions): Promise<boolean> {
		try {
			const nav = navigator as Navigator & { gpu?: GPU };
			if (!nav.gpu) return false;
			const adapter = await nav.gpu.requestAdapter({
				powerPreference: options.powerPreference || "high-performance",
			});
			if (!adapter) return false;
			this.device = await adapter.requestDevice();
			if (!this.device) return false;
			this.context = this.canvas.getContext("webgpu");
			if (!this.context) return false;
			const canvasFormat = nav.gpu.getPreferredCanvasFormat();
			this.context.configure({
				device: this.device,
				format: canvasFormat,
				usage: GPUTextureUsage.RENDER_ATTACHMENT,
				alphaMode: "opaque",
			});
			await this.createRenderPipeline();
			this.createVertexBuffer();
			this.isInitialized = true;
			return true;
		} catch {
			return false;
		}
	}

	private async createRenderPipeline(): Promise<void> {
		if (!this.device) return;
		const vertexShaderModule = this.device.createShaderModule({
			code: this.vertexShaderSource,
		});
		const fragmentShaderModule = this.device.createShaderModule({
			code: this.fragmentShaderSource,
		});
		this.pipeline = this.device.createRenderPipeline({
			layout: "auto",
			vertex: {
				module: vertexShaderModule,
				entryPoint: "vs_main",
				buffers: [
					{
						arrayStride: 16,
						attributes: [
							{ shaderLocation: 0, offset: 0, format: "float32x2" },
							{ shaderLocation: 1, offset: 8, format: "float32x2" },
						],
					},
				],
			},
			fragment: {
				module: fragmentShaderModule,
				entryPoint: "fs_main",
				targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
			},
			primitive: { topology: "triangle-strip" },
		});
	}

	private createVertexBuffer(): void {
		if (!this.device) return;
		this.vertexBuffer = this.device.createBuffer({
			size: 4 * 4 * 4,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
	}

	private createTexture(width: number, height: number): void {
		if (!this.device) return;
		if (this.texture) this.texture.destroy();
		this.texture = this.device.createTexture({
			size: { width, height },
			format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		if (!this.sampler) {
			this.sampler = this.device.createSampler({
				magFilter: "linear",
				minFilter: "linear",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			});
		}
		this.createBindGroup();
	}

	private createBindGroup(): void {
		if (!this.device || !this.texture || !this.sampler || !this.pipeline)
			return;
		this.bindGroup = this.device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: this.sampler },
				{ binding: 1, resource: this.texture.createView() },
			],
		});
	}

	public isReady(): boolean {
		return (
			this.isInitialized &&
			this.device !== null &&
			this.context !== null &&
			this.pipeline !== null
		);
	}

	public renderFrame(frame: VideoFrameData): boolean {
		if (!this.isReady() || !this.device || !this.context || !this.pipeline)
			return false;
		try {
			const { width, height, data } = frame;
			if (width === 0 || height === 0) return false;
			const dpr = window.devicePixelRatio || 1;
			const displayWidth = this.canvas.clientWidth;
			const displayHeight = this.canvas.clientHeight;
			const canvasWidth = displayWidth * dpr;
			const canvasHeight = displayHeight * dpr;
			if (
				this.canvas.width !== canvasWidth ||
				this.canvas.height !== canvasHeight
			) {
				this.canvas.width = canvasWidth;
				this.canvas.height = canvasHeight;
			}
			if (width !== this.textureWidth || height !== this.textureHeight) {
				this.createTexture(width, height);
				this.textureWidth = width;
				this.textureHeight = height;
			}
			if (!this.texture) return false;
			// WebGPU requires GPUAllowSharedBufferSource which includes ArrayBufferView
			const view = new Uint8Array(new ArrayBuffer(width * height * 4));
			view.set(data);
			this.device.queue.writeTexture(
				{ texture: this.texture, origin: { x: 0, y: 0, z: 0 } },
				view,
				{ bytesPerRow: width * 4, rowsPerImage: height },
				{ width, height, depthOrArrayLayers: 1 },
			);
			const commandEncoder = this.device.createCommandEncoder();
			const textureView = this.context.getCurrentTexture().createView();
			const renderPass = commandEncoder.beginRenderPass({
				colorAttachments: [
					{
						view: textureView,
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: "clear",
						storeOp: "store",
					},
				],
			});
			renderPass.setPipeline(this.pipeline);
			if (this.bindGroup) renderPass.setBindGroup(0, this.bindGroup);
			const scale = Math.min(
				canvasWidth / this.textureWidth,
				canvasHeight / this.textureHeight,
			);
			const drawW = Math.floor(this.textureWidth * scale);
			const drawH = Math.floor(this.textureHeight * scale);
			const x = Math.floor((canvasWidth - drawW) / 2);
			const y = Math.floor((canvasHeight - drawH) / 2);
			const left = (x / canvasWidth) * 2 - 1;
			const right = ((x + drawW) / canvasWidth) * 2 - 1;
			const top = 1 - (y / canvasHeight) * 2;
			const bottom = 1 - ((y + drawH) / canvasHeight) * 2;
			const quad = new Float32Array([
				left,
				bottom,
				0.0,
				1.0,
				right,
				bottom,
				1.0,
				1.0,
				left,
				top,
				0.0,
				0.0,
				right,
				top,
				1.0,
				0.0,
			]);
			if (this.vertexBuffer) {
				this.device.queue.writeBuffer(this.vertexBuffer, 0, quad);
				renderPass.setVertexBuffer(0, this.vertexBuffer);
			}
			renderPass.draw(4, 1, 0, 0);
			renderPass.end();
			this.device.queue.submit([commandEncoder.finish()]);
			return true;
		} catch {
			return false;
		}
	}

	public clear(): void {
		if (!this.isReady() || !this.device || !this.context) return;
		try {
			const commandEncoder = this.device.createCommandEncoder();
			const textureView = this.context.getCurrentTexture().createView();
			const renderPass = commandEncoder.beginRenderPass({
				colorAttachments: [
					{
						view: textureView,
						clearValue: { r: 0, g: 0, b: 0, a: 1 },
						loadOp: "clear",
						storeOp: "store",
					},
				],
			});
			renderPass.end();
			this.device.queue.submit([commandEncoder.finish()]);
		} catch {}
	}

	public dispose(): void {
		try {
			if (this.texture) {
				this.texture.destroy();
				this.texture = null;
			}
			if (this.vertexBuffer) {
				this.vertexBuffer.destroy();
				this.vertexBuffer = null;
			}
			this.device = null;
			this.context = null;
			this.pipeline = null;
			this.sampler = null;
			this.bindGroup = null;
			this.isInitialized = false;
		} catch {}
	}
}
