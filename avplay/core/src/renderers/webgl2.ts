import type { IVideoRenderer, VideoFrameData } from "../types/renderers";
import type {
	RenderStats,
	WebGLRendererOptions,
	WebGLResources,
} from "../types/webgl";

export class WebGLVideoRenderer implements IVideoRenderer {
	private resources: WebGLResources;
	private isInitialized = false;
	private stats: RenderStats;
	private lastFrameTime = 0;
	private canvas: HTMLCanvasElement;
	private textureWidth = 0;
	private textureHeight = 0;

	private readonly vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = a_texCoord;
    }
  `;

	private readonly fragmentShaderSource = `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_texCoord;

    void main() {
      vec4 color = texture2D(u_texture, v_texCoord);
      gl_FragColor = color;
    }
  `;

	constructor(options: WebGLRendererOptions) {
		this.canvas = options.canvas;
		this.resources = {
			gl: null,
			program: null,
			texture: null,
			vertexBuffer: null,
			texCoordBuffer: null,
			positionLocation: -1,
			texCoordLocation: -1,
			textureLocation: null,
		};

		this.stats = {
			fps: 0,
			frameTime: 0,
			droppedFrames: 0,
			textureUploads: 0,
		};

		this.initialize(options);
	}

	private initialize(options: WebGLRendererOptions): boolean {
		try {
			const contextOptions: WebGLContextAttributes = {
				alpha: options.alpha ?? false,
				antialias: options.antialias ?? false,
				depth: false,
				stencil: false,
				preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
				powerPreference: options.powerPreference ?? "high-performance",
			};

			const gl =
				(this.canvas.getContext(
					"webgl",
					contextOptions,
				) as WebGLRenderingContext | null) ||
				(this.canvas.getContext(
					"experimental-webgl",
					contextOptions,
				) as WebGLRenderingContext | null);
			if (!gl) return false;
			this.resources.gl = gl;

			const vertexShader = this.createShader(
				gl,
				(gl as WebGLRenderingContext).VERTEX_SHADER,
				this.vertexShaderSource,
			);
			const fragmentShader = this.createShader(
				gl,
				(gl as WebGLRenderingContext).FRAGMENT_SHADER,
				this.fragmentShaderSource,
			);
			if (!vertexShader || !fragmentShader)
				throw new Error("Failed to create shaders");

			const program = gl.createProgram();
			if (!program) throw new Error("Failed to create program");
			gl.attachShader(program, vertexShader);
			gl.attachShader(program, fragmentShader);
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
				const error = gl.getProgramInfoLog(program);
				throw new Error(`Failed to link program: ${error}`);
			}
			this.resources.program = program;

			this.resources.positionLocation = gl.getAttribLocation(
				program,
				"a_position",
			);
			this.resources.texCoordLocation = gl.getAttribLocation(
				program,
				"a_texCoord",
			);
			this.resources.textureLocation = gl.getUniformLocation(
				program,
				"u_texture",
			);

			this.setupQuadBuffers(gl);

			const texture = gl.createTexture();
			if (!texture) throw new Error("Failed to create texture");
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			this.resources.texture = texture;

			gl.disable(gl.DEPTH_TEST);
			gl.disable(gl.CULL_FACE);
			gl.disable(gl.BLEND);

			this.canvas.addEventListener(
				"webglcontextlost",
				this.handleContextLost.bind(this),
				false,
			);
			this.canvas.addEventListener(
				"webglcontextrestored",
				this.handleContextRestored.bind(this),
				false,
			);

			this.isInitialized = true;
			return true;
		} catch {
			this.cleanup();
			return false;
		}
	}

	private createShader(
		gl: WebGLRenderingContext,
		type: number,
		source: string,
	): WebGLShader | null {
		const shader = gl.createShader(type);
		if (!shader) return null;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	}

	private setupQuadBuffers(gl: WebGLRenderingContext): void {
		const positions = new Float32Array([
			-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0,
		]);
		const texCoords = new Float32Array([
			0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
		]);
		const positionBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
		this.resources.vertexBuffer = positionBuffer;
		const texCoordBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
		this.resources.texCoordBuffer = texCoordBuffer;
	}

	public renderFrame(frameData: VideoFrameData): boolean {
		if (!this.isInitialized || !this.resources.gl) return false;
		const gl = this.resources.gl;
		try {
			const now = performance.now();
			if (this.lastFrameTime > 0) {
				this.stats.frameTime = now - this.lastFrameTime;
				this.stats.fps = 1000 / this.stats.frameTime;
			}
			this.lastFrameTime = now;

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
				gl.viewport(0, 0, canvasWidth, canvasHeight);
			}

			gl.bindTexture(gl.TEXTURE_2D, this.resources.texture);
			if (
				frameData.width !== this.textureWidth ||
				frameData.height !== this.textureHeight
			) {
				gl.texImage2D(
					gl.TEXTURE_2D,
					0,
					gl.RGBA,
					frameData.width,
					frameData.height,
					0,
					gl.RGBA,
					gl.UNSIGNED_BYTE,
					frameData.data,
				);
				this.textureWidth = frameData.width;
				this.textureHeight = frameData.height;
				gl.clear(gl.COLOR_BUFFER_BIT);
			} else {
				gl.texSubImage2D(
					gl.TEXTURE_2D,
					0,
					0,
					0,
					frameData.width,
					frameData.height,
					gl.RGBA,
					gl.UNSIGNED_BYTE,
					frameData.data,
				);
			}
			this.stats.textureUploads++;

			gl.clearColor(0.0, 0.0, 0.0, 1.0);
			gl.clear(gl.COLOR_BUFFER_BIT);

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
			const positions = new Float32Array([
				left,
				bottom,
				right,
				bottom,
				left,
				top,
				right,
				top,
			]);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.resources.vertexBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

			gl.useProgram(this.resources.program);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.resources.vertexBuffer);
			gl.enableVertexAttribArray(this.resources.positionLocation);
			gl.vertexAttribPointer(
				this.resources.positionLocation,
				2,
				gl.FLOAT,
				false,
				0,
				0,
			);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.resources.texCoordBuffer);
			gl.enableVertexAttribArray(this.resources.texCoordLocation);
			gl.vertexAttribPointer(
				this.resources.texCoordLocation,
				2,
				gl.FLOAT,
				false,
				0,
				0,
			);
			gl.uniform1i(this.resources.textureLocation, 0);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			return true;
		} catch {
			this.stats.droppedFrames++;
			return false;
		}
	}

	public clear(): void {
		if (!this.resources.gl) return;
		const gl = this.resources.gl;
		gl.clearColor(0.0, 0.0, 0.0, 1.0);
		gl.clear(gl.COLOR_BUFFER_BIT);
	}

	// viewport mode not supported in this implementation

	public getStats(): RenderStats {
		return { ...this.stats };
	}

	public isReady(): boolean {
		return this.isInitialized && this.resources.gl !== null;
	}

	private handleContextLost(event: Event): void {
		event.preventDefault();
		this.isInitialized = false;
	}

	private handleContextRestored(): void {
		this.initialize({ canvas: this.canvas });
	}

	public cleanup(): void {
		const gl = this.resources.gl;
		if (!gl) return;
		if (this.resources.texture) gl.deleteTexture(this.resources.texture);
		if (this.resources.vertexBuffer)
			gl.deleteBuffer(this.resources.vertexBuffer);
		if (this.resources.texCoordBuffer)
			gl.deleteBuffer(this.resources.texCoordBuffer);
		if (this.resources.program) gl.deleteProgram(this.resources.program);
		this.resources = {
			gl: null,
			program: null,
			texture: null,
			vertexBuffer: null,
			texCoordBuffer: null,
			positionLocation: -1,
			texCoordLocation: -1,
			textureLocation: null,
		};
		this.isInitialized = false;
	}

	public dispose(): void {
		if (this.resources.gl) {
			const loseExt = (this.resources.gl as WebGLRenderingContext).getExtension(
				"WEBGL_lose_context",
			) as { loseContext: () => void } | null;
			if (loseExt) {
				try {
					loseExt.loseContext();
				} catch {}
			}
		}
		this.cleanup();
		this.canvas.removeEventListener(
			"webglcontextlost",
			this.handleContextLost.bind(this),
		);
		this.canvas.removeEventListener(
			"webglcontextrestored",
			this.handleContextRestored.bind(this),
		);
	}
}
