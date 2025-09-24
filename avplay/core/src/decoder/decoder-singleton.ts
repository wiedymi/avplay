import type { FileInfo, FrameData } from "../types/decoder";
// URLs are provided by the host application (e.g., demo) via setAssetUrls

interface WorkerMessage {
	type: string;
	data?: unknown;
	id: number;
}

interface WorkerResponse {
	type: string;
	data?: unknown;
	id?: number;
	error?: string;
}

interface PendingEntry {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

class DecoderSingleton {
	private static instance: DecoderSingleton | null = null;
	private worker: Worker | null = null;
	private isInitialized = false;
	private status = "INITIALIZING";
	private error: string | null = null;
	private pending = new Map<number, PendingEntry>();
	private nextId = 0;
	private onFrame: ((data: FrameData) => void) | null = null;
	private onError: ((error: string) => void) | null = null;
	private messageTimeoutMs = 30000;
	private assetWorkerUrl: string | null = null;
	private assetDecoderUrl: string | null = null;

	private constructor() {
		if (typeof window !== "undefined") {
			window.addEventListener("beforeunload", () => {
				this.cleanup().catch(() => {});
			});
		}
	}

	static getInstance(): DecoderSingleton {
		if (!DecoderSingleton.instance)
			DecoderSingleton.instance = new DecoderSingleton();
		return DecoderSingleton.instance;
	}

	private handleMessage = (event: MessageEvent<WorkerResponse>) => {
		const { type, id, data, error } = event.data;
		if (typeof id === "number") {
			const p = this.pending.get(id);
			if (p) {
				clearTimeout(p.timeout);
				this.pending.delete(id);
				return error ? p.reject(new Error(error)) : p.resolve(data);
			}
		}
		if (type === "frame_decoded" && this.onFrame && data)
			this.onFrame(data as FrameData);
		if (type === "error" && this.onError && error) this.onError(error);
	};

	private request<T = unknown>(
		type: string,
		data?: unknown,
		idOverride?: number,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			if (!this.worker) return reject(new Error("Worker not initialized"));

			const id = idOverride ?? ++this.nextId;
			const timeout = setTimeout(() => {
				console.log("request: timeout", timeout);
				if (this.pending.has(id)) {
					console.log("request: timeout: pending", this.pending);
					this.pending.delete(id);
					reject(
						new Error(
							`Worker message timeout after ${this.messageTimeoutMs}ms`,
						),
					);
				}
			}, this.messageTimeoutMs);

			this.pending.set(id, {
				resolve: (v: unknown) => resolve(v as T),
				reject: (e: Error) => reject(e),
				timeout,
			});

			this.worker.postMessage({ type, data, id } satisfies WorkerMessage);
		});
	}

	async initializeDecoder(): Promise<{
		success: boolean;
		version?: string;
		error?: string;
	}> {
		if (this.worker || this.isInitialized)
			return { success: true, version: "Already initialized" };
		this.status = "LOADING WASM MODULE";
		this.error = null;
		// Resolve worker and decoder asset URLs from configured assets
		const resolvedWorkerUrl = this.assetWorkerUrl ?? "/decoder-worker.js";
		const resolvedDecoderUrl = this.assetDecoderUrl ?? "/decoder.js";

		const worker = new Worker(resolvedWorkerUrl);

		worker.addEventListener("message", this.handleMessage);
		this.worker = worker;

		const result = await this.request<{
			success: boolean;
			version?: string;
			error?: string;
		}>("init", { decoderUrl: resolvedDecoderUrl }, 0);

		if (!result.success) {
			this.status = "ERROR";
			throw new Error(result.error || "Initialization failed");
		}

		this.isInitialized = true;
		this.status = "INITIALIZED";
		return result;
	}

	setAssetUrls(urls: { workerUrl?: string; decoderUrl?: string }) {
		if (typeof urls.workerUrl === "string")
			this.assetWorkerUrl = urls.workerUrl;
		if (typeof urls.decoderUrl === "string")
			this.assetDecoderUrl = urls.decoderUrl;
	}

	loadFile(fileData: Uint8Array): Promise<FileInfo> {
		this.status = "LOADING FILE";
		return this.request<FileInfo>("load_file", fileData).finally(() => {
			if (this.status !== "ERROR") this.status = "READY";
		});
	}
	decodeFrame(): Promise<FrameData> {
		return this.request<FrameData>("decode_frame");
	}
	seek(time: number): Promise<number> {
		return this.request<number>("seek", time);
	}
	pause(): Promise<void> {
		return this.request<void>("pause");
	}
	resume(): Promise<void> {
		return this.request<void>("resume");
	}
	enableSubtitles(enable: boolean): Promise<number> {
		return this.request<number>("enable_subtitles", enable);
	}
	addFont(filename: string, data: Uint8Array): Promise<number> {
		return this.request<number>("add_font", { filename, data });
	}
	loadExternalSubtitles(filename: string, data: Uint8Array): Promise<number> {
		return this.request<number>("load_external_subtitles", { filename, data });
	}
	rebuildSubtitleFilter(): Promise<number> {
		return this.request<number>("rebuild_subtitle_filter");
	}
	extractSubtitleFile(trackIndex: number): Promise<{
		data: Uint8Array;
		size: number;
		format: string;
		filename: string;
	}> {
		return this.request<{
			data: Uint8Array;
			size: number;
			format: string;
			filename: string;
		}>("extract_subtitle_file", trackIndex);
	}
	switchVideoTrack(i: number): Promise<number> {
		return this.request<number>("switch_video_track", i);
	}
	switchAudioTrack(i: number): Promise<number> {
		return this.request<number>("switch_audio_track", i);
	}
	switchSubtitleTrack(i: number): Promise<number> {
		return this.request<number>("switch_subtitle_track", i);
	}
	extractTrack(
		trackType: number,
		trackIndex: number,
	): Promise<{ data: Uint8Array; size: number }> {
		return this.request<{ data: Uint8Array; size: number }>("extract_track", {
			trackType,
			trackIndex,
		});
	}
	getExtractedTrackData(): Promise<Uint8Array | null> {
		return this.request<Uint8Array | null>("get_extracted_track_data");
	}
	freeExtractedTrack(): Promise<{ success: true }> {
		return this.request<{ success: true }>("free_extracted_track");
	}
	getAttachmentData(
		i: number,
	): Promise<{ data: Uint8Array; size: number } | null> {
		return this.request<{ data: Uint8Array; size: number } | null>(
			"get_attachment_data",
			i,
		);
	}
	extractAttachment(i: number): Promise<{ data: Uint8Array; size: number }> {
		return this.request<{ data: Uint8Array; size: number }>(
			"extract_attachment",
			i,
		);
	}

	setFrameDecodedCallback(cb: (data: FrameData) => void) {
		this.onFrame = cb;
	}
	setErrorCallback(cb: (error: string) => void) {
		this.onError = cb;
	}

	get initialized() {
		return this.isInitialized;
	}
	get currentStatus() {
		return this.status;
	}
	get currentError() {
		return this.error;
	}

	createDownloadableBlob(data: Uint8Array, mimeType: string): Blob {
		return new Blob([data.slice().buffer as ArrayBuffer], { type: mimeType });
	}
	getMimeTypeForFormat(format: string): string {
		const m: Record<string, string> = {
			ass: "text/x-ass",
			ssa: "text/x-ssa",
			srt: "text/srt",
			webvtt: "text/vtt",
			mp3: "audio/mpeg",
			aac: "audio/aac",
			flac: "audio/flac",
			wav: "audio/wav",
			mp4: "video/mp4",
			mkv: "video/x-matroska",
			webm: "video/webm",
		};
		return m[format.toLowerCase()] || "application/octet-stream";
	}
	createDownloadUrl(data: Uint8Array, format: string): string {
		const blob = this.createDownloadableBlob(
			data,
			this.getMimeTypeForFormat(format),
		);
		return URL.createObjectURL(blob);
	}

	async cleanup() {
		for (const [, { timeout }] of this.pending) clearTimeout(timeout);
		this.pending.clear();
		if (this.worker) {
			try {
				await Promise.race([
					this.request("destroy"),
					new Promise((_, r) =>
						setTimeout(() => r(new Error("timeout")), 5000),
					),
				]);
			} catch {}
			this.worker.terminate();
			this.worker = null;
		}
		this.isInitialized = false;
		this.status = "INITIALIZING";
		this.error = null;
		this.onFrame = null;
		this.onError = null;
	}
}

export const decoderSingleton = DecoderSingleton.getInstance();
