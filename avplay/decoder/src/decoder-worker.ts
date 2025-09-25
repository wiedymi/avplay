/// <reference lib="WebWorker" />
import type { FileInfo, FrameData } from "./types";

declare const self: DedicatedWorkerGlobalScope;

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

const perfLog = (msg: string, ...args: unknown[]) => {
	console.log(`[PERF] ${msg}`, ...args);
};

const perfTimer = (name: string) => {
	const start = performance.now();
	return {
		end: () => {
			const duration = performance.now() - start;
			perfLog(`${name} took ${duration.toFixed(2)}ms`);
			return duration;
		},
	};
};

// Minimal type for the Emscripten module we import from decoder.js
interface WASMModule {
	ccall: (
		name: string,
		returnType: string | null,
		argTypes: string[],
		args: unknown[],
	) => unknown;
	_malloc: (size: number) => number;
	_free: (ptr: number) => void;
	HEAPU8: Uint8Array;
	HEAPF32: Float32Array;
}

declare function createDecoderModule(config?: {
	mainScriptUrlOrBlob?: string | Blob;
	print?: (text: string) => void;
	printErr?: (text: string) => void;
	locateFile?: (path: string) => string;
}): Promise<WASMModule>;

const TRACK_TYPE_LABEL: Record<number, "video" | "audio" | "subtitle"> = {
	0: "video",
	1: "audio",
	2: "subtitle",
};

const normalizeFormat = (format: unknown): string =>
	typeof format === "string" && format.trim().length > 0
		? format.trim().toLowerCase()
		: "";

const determineTrackFormat = (trackInfo: string, trackType: number, data: Uint8Array): string => {
	const lower = trackInfo.toLowerCase();

	if (trackType === 2) { // Subtitle
		if (lower.includes("ass") || lower.includes("ssa")) return "ass";
		if (lower.includes("subrip") || lower.includes("srt")) return "srt";
		if (lower.includes("webvtt")) return "webvtt";
		if (lower.includes("mov_text")) return "srt";

		// Check data content for format detection
		const textData = new TextDecoder("utf-8").decode(data.slice(0, Math.min(1024, data.length)));
		if (textData.includes("[Script Info]") || textData.includes("Dialogue:")) return "ass";
		if (textData.includes("WEBVTT")) return "webvtt";
		if (/\d+\s*\n\d{2}:\d{2}:\d{2}/.test(textData)) return "srt";
		return "srt";
	} else if (trackType === 1) { // Audio
		if (lower.includes("mp3")) return "mp3";
		if (lower.includes("aac")) return "adts";
		if (lower.includes("ac3")) return "ac3";
		if (lower.includes("flac")) return "flac";
		if (lower.includes("vorbis")) return "ogg";
		if (lower.includes("opus")) return "opus";
		if (lower.includes("pcm")) return "wav";
		return "matroska";
	} else if (trackType === 0) { // Video
		if (lower.includes("vp8") || lower.includes("vp9")) return "webm";
		if (lower.includes("h.264") || lower.includes("h264")) return "matroska";
		if (lower.includes("av1")) return "matroska";
		return "matroska";
	}

	return "binary";
};

const formatToExtension = (format: string, trackType: number): string => {
	const map: Record<string, string> = {
		ass: "ass",
		ssa: "ssa",
		srt: "srt",
		webvtt: "vtt",
		vtt: "vtt",
		mp3: "mp3",
		aac: "aac",
		ac3: "ac3",
		flac: "flac",
		ogg: "ogg",
		opus: "opus",
		wav: "wav",
		webm: "webm",
		mp4: "mp4",
		m4a: "m4a",
		mpegts: "ts",
		ts: "ts",
	};
	if (format === "matroska") {
		return trackType === 0 ? "mkv" : trackType === 1 ? "mka" : "mks";
	}
	if (format === "mov_text") {
		return "srt";
	}
	return map[format] ?? (format || (trackType === 0 ? "mkv" : "bin"));
};

const extensionToMime = (extension: string, trackType: number): string => {
	const map: Record<string, string> = {
		ass: "text/x-ass",
		ssa: "text/x-ssa",
		srt: "text/srt",
		vtt: "text/vtt",
		mp3: "audio/mpeg",
		aac: "audio/aac",
		ac3: "audio/ac3",
		flac: "audio/flac",
		ogg: "audio/ogg",
		opus: "audio/opus",
		wav: "audio/wav",
		webm: trackType === 0 ? "video/webm" : "audio/webm",
		mp4: trackType === 0 ? "video/mp4" : "audio/mp4",
		m4a: "audio/mp4",
		mkv: "video/x-matroska",
		mka: "audio/x-matroska",
		mks: "text/x-matroska",
		ts: "video/mp2t",
	};
	return map[extension] ?? "application/octet-stream";
};

const sanitize = (s: string): string =>
  s
    .normalize("NFKC")
    // Keep all unicode letters/numbers and a small safe set of symbols
    .replace(/[^\p{L}\p{N}\-._\s\[\]\(\)]/gu, "")
    .replace(/\s+/g, "_")
    .slice(0, 100);

const parseLangAndTitle = (info: string | undefined) => {
	if (!info) return { lang: "", title: "" } as const;
	const mLang = info.match(/\[([^\]]+)\]/); // [eng]
	const mTitle = info.match(/"([^"]+)"/); // "Title"
	return { lang: mLang?.[1] ?? "", title: mTitle?.[1] ?? "" } as const;
};

const buildTrackFilename = (
	trackType: number,
	trackIndex: number,
	extension: string,
	info?: string,
): string => {
	const base = TRACK_TYPE_LABEL[trackType] ?? "track";
	const { lang, title } = parseLangAndTitle(info);
	const parts = [
		`${base}_track_${trackIndex + 1}`,
		lang ? sanitize(lang) : "",
		title ? sanitize(title) : "",
	].filter(Boolean);
	const name = parts.join(".");
	return extension ? `${name}.${extension}` : name;
};


class DecoderWorker {
	private module: WASMModule | null = null;
	private decoderHandle: number = 0;
	private isInitialized = false;
	private isPaused = false;


	async init(decoderUrl?: string): Promise<{
		success: boolean;
		version?: string;
		error?: string;
	}> {
		const timer = perfTimer("decoder_init");
		try {
			if (this.isInitialized) {
				return { success: true, version: "Already initialized" };
			}
			const loadTimer = perfTimer("script_load");
			const url = decoderUrl || "/decoder.js";
			console.log(`Loading decoder script from ${url}`);
			self.importScripts(url);
			console.log(`Decoder script loaded from ${url}`);
			loadTimer.end();
			if (typeof createDecoderModule === "undefined") {
				throw new Error("createDecoderModule is not available");
			}
			const moduleTimer = perfTimer("module_creation");
			console.log("Creating decoder module...");
			// Initialize module with WASM Workers support
			this.module = await createDecoderModule({
				print: (text: string) => console.log("[WASM]", text),
				printErr: (text: string) => console.error("[WASM]", text),
				locateFile: (path: string) => {
					console.log(`Locating file ${path}`);
					if (path.endsWith(".wasm")) {
						return url.replace(".js", ".wasm");
					}
					return path;
				}
			});
			moduleTimer.end();
			this.isInitialized = true;
			const version = this.module.ccall(
				"decoder_get_version",
				"string",
				[],
				[],
			) as string;
			timer.end();
			return { success: true, version };
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown initialization error";
			return { success: false, error: errorMessage };
		}
	}

	async loadFile(fileData: Uint8Array): Promise<FileInfo> {
		const timer = perfTimer("loadFile");
		if (!this.isInitialized || !this.module)
			throw new Error("Decoder not initialized");
		if (this.decoderHandle !== 0) {
			this.module.ccall(
				"decoder_destroy",
				null,
				["number"],
				[this.decoderHandle],
			);
		}
		const createTimer = perfTimer("decoder_create");
		this.decoderHandle = this.module.ccall(
			"decoder_create",
			"number",
			[],
			[],
		) as number;
		createTimer.end();
		if (this.decoderHandle === 0) throw new Error("Failed to create decoder");
		const dataPtr = this.module._malloc(fileData.length);
		this.module.HEAPU8.set(fileData, dataPtr);
		const initResult = this.module.ccall(
			"decoder_init_format",
			"number",
			["number", "number", "number"],
			[this.decoderHandle, dataPtr, fileData.length],
		) as number;
		if (initResult < 0) {
			this.module._free(dataPtr);
			throw new Error("Failed to initialize decoder");
		}
		const fileInfo = this.gatherFileInfo();
		timer.end();
		return fileInfo;
	}

	private gatherFileInfo(): FileInfo {
		if (!this.module) throw new Error("Module not initialized");
		const videoTrackCount = this.module.ccall(
			"decoder_get_video_track_count",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		const audioTrackCount = this.module.ccall(
			"decoder_get_audio_track_count",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		const subtitleTrackCount = this.module.ccall(
			"decoder_get_subtitle_track_count",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		const attachmentCount = this.module.ccall(
			"decoder_get_attachment_count",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		const videoTracks: string[] = [];
		for (let i = 0; i < videoTrackCount; i++) {
			videoTracks.push(
				this.module.ccall(
					"decoder_get_video_track_info",
					"string",
					["number", "number"],
					[this.decoderHandle, i],
				) as string,
			);
		}
		const audioTracks: string[] = [];
		for (let i = 0; i < audioTrackCount; i++) {
			audioTracks.push(
				this.module.ccall(
					"decoder_get_audio_track_info",
					"string",
					["number", "number"],
					[this.decoderHandle, i],
				) as string,
			);
		}
		const subtitleTracks: string[] = [];
		for (let i = 0; i < subtitleTrackCount; i++) {
			subtitleTracks.push(
				this.module.ccall(
					"decoder_get_subtitle_track_info",
					"string",
					["number", "number"],
					[this.decoderHandle, i],
				) as string,
			);
		}
		const attachments: string[] = [];
		for (let i = 0; i < attachmentCount; i++) {
			attachments.push(
				this.module.ccall(
					"decoder_get_attachment_info",
					"string",
					["number", "number"],
					[this.decoderHandle, i],
				) as string,
			);
		}
		const codecName = this.module.ccall(
			"decoder_get_codec_name",
			"string",
			["number"],
			[this.decoderHandle],
		) as string;
		const hasAudio = this.module.ccall(
			"decoder_has_audio",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		const audioCodecName = hasAudio
			? (this.module.ccall(
					"decoder_get_audio_codec_name",
					"string",
					["number"],
					[this.decoderHandle],
				) as string)
			: "";
		const duration = this.module.ccall(
			"decoder_get_duration",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		return {
			videoTracks,
			audioTracks,
			subtitleTracks,
			attachments,
			codecName,
			audioCodec: audioCodecName,
			hasAudio: !!hasAudio,
			duration,
			trackCounts: {
				video: videoTrackCount,
				audio: audioTrackCount,
				subtitle: subtitleTrackCount,
				attachment: attachmentCount,
			},
		};
	}

	async decodeFrame(): Promise<FrameData> {
		if (!this.module) throw new Error("Module not initialized");
		if (this.isPaused) throw new Error("Decoder is paused");
		const result = this.module.ccall(
			"decoder_decode_frame",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		if (result !== 0)
			throw new Error(`Frame decode failed with result: ${result}`);
		const width = this.module.ccall(
			"decoder_get_width",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		const height = this.module.ccall(
			"decoder_get_height",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		let rgbData: Uint8ClampedArray;
		if (width > 0 && height > 0) {
			const rgbPtr = this.module.ccall(
				"decoder_get_frame_rgb",
				"number",
				["number"],
				[this.decoderHandle],
			) as number;
			if (rgbPtr !== 0) {
				const rgbSize = width * height * 4;
				rgbData = new Uint8ClampedArray(
					this.module.HEAPU8.buffer,
					rgbPtr,
					rgbSize,
				);
				rgbData = new Uint8ClampedArray(rgbData);
			} else {
				rgbData = new Uint8ClampedArray(width * height * 4);
			}
		} else {
			rgbData = new Uint8ClampedArray(0);
		}
		let audioData: Float32Array | undefined;
		let audioSampleRate: number | undefined;
		let audioChannels: number | undefined;
		const hasAudio = this.module.ccall(
			"decoder_has_audio",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		if (hasAudio) {
			const audioBufferSize = this.module.ccall(
				"decoder_get_audio_buffer_size",
				"number",
				["number"],
				[this.decoderHandle],
			) as number;
			if (audioBufferSize > 0) {
				const audioPtr = this.module.ccall(
					"decoder_get_audio_buffer",
					"number",
					["number"],
					[this.decoderHandle],
				) as number;
				if (audioPtr !== 0) {
					const samples = audioBufferSize / 4;
					audioData = new Float32Array(
						this.module.HEAPF32.buffer,
						audioPtr,
						samples,
					);
					audioData = new Float32Array(audioData);
					audioSampleRate = this.module.ccall(
						"decoder_get_audio_sample_rate",
						"number",
						["number"],
						[this.decoderHandle],
					) as number;
					audioChannels = this.module.ccall(
						"decoder_get_audio_channels",
						"number",
						["number"],
						[this.decoderHandle],
					) as number;
					this.module.ccall(
						"decoder_clear_audio_buffer",
						null,
						["number"],
						[this.decoderHandle],
					);
				}
			}
		}
		const codecName = this.module.ccall(
			"decoder_get_codec_name",
			"string",
			["number"],
			[this.decoderHandle],
		) as string;
		const frameTimestamp = this.module.ccall(
			"decoder_get_frame_timestamp",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
		const frameData: FrameData = {
			width,
			height,
			rgbData,
			codecName,
			audioData,
			audioSampleRate,
			audioChannels,
			timestamp: frameTimestamp,
		};
		const transferList: Transferable[] = [];
		if (rgbData && rgbData.length > 0) transferList.push(rgbData.buffer);
		if (audioData && audioData.length > 0) transferList.push(audioData.buffer);
		self.postMessage({ type: "frame_decoded", data: frameData }, transferList);
		return frameData;
	}

	async seek(time: number): Promise<number> {
		if (!this.module) throw new Error("Module not initialized");
		return this.module.ccall(
			"decoder_seek",
			"number",
			["number", "number"],
			[this.decoderHandle, time],
		) as number;
	}

	async switchVideoTrack(trackIndex: number): Promise<number> {
		if (!this.module) throw new Error("Module not initialized");
		return this.module.ccall(
			"decoder_switch_video_track",
			"number",
			["number", "number"],
			[this.decoderHandle, trackIndex],
		) as number;
	}

	async switchAudioTrack(trackIndex: number): Promise<number> {
		if (!this.module) throw new Error("Module not initialized");
		return this.module.ccall(
			"decoder_switch_audio_track",
			"number",
			["number", "number"],
			[this.decoderHandle, trackIndex],
		) as number;
	}

	async switchSubtitleTrack(trackIndex: number): Promise<number> {
		if (!this.module) throw new Error("Module not initialized");
		return this.module.ccall(
			"decoder_switch_subtitle_track",
			"number",
			["number", "number"],
			[this.decoderHandle, trackIndex],
		) as number;
	}

	async enableSubtitles(enable: boolean): Promise<number> {
		if (!this.module) throw new Error("Module not initialized");
		return this.module.ccall(
			"decoder_enable_filter_subtitles",
			"number",
			["number", "number"],
			[this.decoderHandle, enable ? 1 : 0],
		) as number;
	}

	async extractSubtitleFile(trackIndex: number): Promise<{
		data: Uint8Array;
		size: number;
		format: string;
		filename: string;
	}> {
		if (!this.module) throw new Error("Module not initialized");

		const trackInfo = this.module.ccall(
			"decoder_get_subtitle_track_info",
			"string",
			["number", "number"],
			[this.decoderHandle, trackIndex],
		) as string;

		// Start streaming extraction
		const result = this.module.ccall(
			"decoder_extract_track_start",
			"number",
			["number", "number", "number"],
			[this.decoderHandle, 2, trackIndex],
		) as number;

		if (result <= 0) {
			throw new Error(`Subtitle extraction failed to start: ${result}`);
		}

		// Stream data chunks
		const chunks: Uint8Array[] = [];
		let totalSize = 0;
		const chunkSize = 65536; // 64KB chunks
		const buffer = this.module._malloc(chunkSize);

		try {
			let bytesRead: number;
			while ((bytesRead = this.module.ccall(
				"decoder_extract_track_chunk",
				"number",
				["number", "number"],
				[buffer, chunkSize],
			) as number) > 0) {
				const chunk = new Uint8Array(bytesRead);
				chunk.set(this.module.HEAPU8.subarray(buffer, buffer + bytesRead));
				chunks.push(chunk);
				totalSize += bytesRead;
			}
		} finally {
			this.module._free(buffer);
			this.module.ccall("decoder_extract_track_end", null, [], []);
		}

		// Combine chunks
		const extractedData = new Uint8Array(totalSize);
		let offset = 0;
		for (const chunk of chunks) {
			extractedData.set(chunk, offset);
			offset += chunk.length;
		}

		let format = "unknown";
		let filename = `subtitle_${trackIndex}`;
		const lower = trackInfo.toLowerCase();

		if (lower.includes("ass") || lower.includes("ssa")) {
			format = "ass";
			filename = `subtitle_${trackIndex}.ass`;
		} else if (lower.includes("subrip") || lower.includes("srt")) {
			format = "srt";
			filename = `subtitle_${trackIndex}.srt`;
		} else if (lower.includes("webvtt")) {
			format = "webvtt";
			filename = `subtitle_${trackIndex}.vtt`;
		} else if (lower.includes("mov_text")) {
			format = "srt";
			filename = `subtitle_${trackIndex}.srt`;
		} else {
			const textData = new TextDecoder("utf-8").decode(
				extractedData.slice(0, Math.min(1024, extractedData.length)),
			);
			if (
				textData.includes("[Script Info]") ||
				textData.includes("Dialogue:")
			) {
				format = "ass";
				filename = `subtitle_${trackIndex}.ass`;
			} else if (textData.includes("WEBVTT")) {
				format = "webvtt";
				filename = `subtitle_${trackIndex}.vtt`;
			} else if (/\d+\s*\n\d{2}:\d{2}:\d{2}/.test(textData)) {
				format = "srt";
				filename = `subtitle_${trackIndex}.srt`;
			} else {
				format = "srt";
				filename = `subtitle_${trackIndex}.srt`;
			}
		}

		return { data: extractedData, size: totalSize, format, filename };
	}

	async extractTrack(
		trackType: number,
		trackIndex: number,
	): Promise<{
		data: Uint8Array;
		size: number;
		format: string;
		extension: string;
		mimeType: string;
		filename: string;
	}> {
		if (!this.module) throw new Error("Module not initialized");

		// Start streaming extraction
		const result = this.module.ccall(
			"decoder_extract_track_start",
			"number",
			["number", "number", "number"],
			[this.decoderHandle, trackType, trackIndex],
		) as number;

		console.log(`Extract track start result: ${result} for trackType: ${trackType}, trackIndex: ${trackIndex}`);
		if (result <= 0) {
			throw new Error(`Track extraction failed to start: ${result}`);
		}

		// Stream data chunks
		const chunks: Uint8Array[] = [];
		let totalSize = 0;
		const chunkSize = 65536; // 64KB chunks
		const buffer = this.module._malloc(chunkSize);

		try {
			let bytesRead: number;
			let chunkCount = 0;
			while ((bytesRead = this.module.ccall(
				"decoder_extract_track_chunk",
				"number",
				["number", "number"],
				[buffer, chunkSize],
			) as number) > 0) {
				// Copy chunk data
				const chunk = new Uint8Array(bytesRead);
				chunk.set(this.module.HEAPU8.subarray(buffer, buffer + bytesRead));
				chunks.push(chunk);
				totalSize += bytesRead;
				chunkCount++;

				if (chunkCount === 1) {
					console.log(`First chunk received: ${bytesRead} bytes for trackType: ${trackType}, trackIndex: ${trackIndex}`);
				}
			}
			console.log(`Extraction complete: ${chunkCount} chunks, ${totalSize} total bytes for trackType: ${trackType}, trackIndex: ${trackIndex}`);
		} finally {
			this.module._free(buffer);
			// Clean up streaming state
			this.module.ccall("decoder_extract_track_end", null, [], []);
		}

		if (totalSize === 0) {
			console.error(`No data extracted from track - trackType: ${trackType}, trackIndex: ${trackIndex}, chunks: ${chunks.length}`);
			throw new Error("No data extracted from track");
		}

		// Concatenate all chunks
		const extractedData = new Uint8Array(totalSize);
		let offset = 0;
		for (const chunk of chunks) {
			extractedData.set(chunk, offset);
			offset += chunk.length;
		}

		// Get track info to determine format
		let trackInfo = "";
		if (trackType === 0) { // Video
			trackInfo = this.module.ccall(
				"decoder_get_video_track_info",
				"string",
				["number", "number"],
				[this.decoderHandle, trackIndex],
			) as string;
		} else if (trackType === 1) { // Audio
			trackInfo = this.module.ccall(
				"decoder_get_audio_track_info",
				"string",
				["number", "number"],
				[this.decoderHandle, trackIndex],
			) as string;
		} else if (trackType === 2) { // Subtitle
			trackInfo = this.module.ccall(
				"decoder_get_subtitle_track_info",
				"string",
				["number", "number"],
				[this.decoderHandle, trackIndex],
			) as string;
		}

		// Determine format based on track info and type
		const normalizedFormat = determineTrackFormat(trackInfo, trackType, extractedData);
		const extension = formatToExtension(normalizedFormat, trackType);
		const mimeType = extensionToMime(extension, trackType);

		const filename = buildTrackFilename(trackType, trackIndex, extension, trackInfo);

		return {
			data: extractedData,
			size: totalSize,
			format: normalizedFormat || "binary",
			extension,
			mimeType,
			filename,
		};
	}


	async getAttachmentData(
		attachmentIndex: number,
	): Promise<{ data: Uint8Array; size: number } | null> {
		if (!this.module) throw new Error("Module not initialized");
		const ptr = this.module.ccall(
			"decoder_get_attachment_data",
			"number",
			["number", "number"],
			[this.decoderHandle, attachmentIndex],
		) as number;
		if (!ptr) return null;
		const size = this.module.ccall(
			"decoder_get_attachment_size",
			"number",
			["number", "number"],
			[this.decoderHandle, attachmentIndex],
		) as number;
		if (size <= 0) return null;
		const data = new Uint8Array(this.module.HEAPU8.buffer, ptr, size).slice();
		return { data, size };
	}

	async addFont(filename: string, data: Uint8Array): Promise<number> {
		if (!this.module) throw new Error("Module not initialized");
		if (!this.decoderHandle) throw new Error("Decoder not created");
		const ptr = this.module._malloc(data.length);
		try {
			this.module.HEAPU8.set(data, ptr);
			return this.module.ccall(
				"decoder_add_font",
				"number",
				["number", "string", "number", "number"],
				[this.decoderHandle, filename, ptr, data.length],
			) as number;
		} finally {
			this.module._free(ptr);
		}
	}

	async loadExternalSubtitles(
		filename: string,
		data: Uint8Array,
	): Promise<number> {
		if (!this.module) throw new Error("Module not initialized");
		if (!this.decoderHandle) throw new Error("Decoder not created");
		const ptr = this.module._malloc(data.length);
		try {
			this.module.HEAPU8.set(data, ptr);
			return this.module.ccall(
				"decoder_load_external_subtitles",
				"number",
				["number", "string", "number", "number"],
				[this.decoderHandle, filename, ptr, data.length],
			) as number;
		} finally {
			this.module._free(ptr);
		}
	}

	async rebuildSubtitleFilter(): Promise<number> {
		if (!this.module) throw new Error("Module not initialized");
		if (!this.decoderHandle) throw new Error("Decoder not created");
		return this.module.ccall(
			"decoder_rebuild_subtitle_filter",
			"number",
			["number"],
			[this.decoderHandle],
		) as number;
	}

	async pause(): Promise<void> {
		this.isPaused = true;
	}
	async resume(): Promise<void> {
		this.isPaused = false;
	}
	destroy(): void {
		if (this.decoderHandle !== 0 && this.module) {
			this.module.ccall(
				"decoder_destroy",
				null,
				["number"],
				[this.decoderHandle],
			);
			this.decoderHandle = 0;
		}
		this.isInitialized = false;
		this.isPaused = false;
	}
}

const worker = new DecoderWorker();

self.addEventListener("message", async (event: MessageEvent<WorkerMessage>) => {
	const { type, data, id } = event.data;
	try {
		let result: unknown;
		switch (type) {
			case "init":
				if (
					data &&
					typeof (data as { decoderUrl?: string }).decoderUrl === "string"
				)
				result = await worker.init((data as { decoderUrl?: string }).decoderUrl);
				break;
			case "load_file":
				result = await worker.loadFile(data as Uint8Array);
				break;
			case "decode_frame":
				result = await worker.decodeFrame();
				break;
			case "seek":
				result = await worker.seek(data as number);
				break;
			case "switch_video_track":
				result = await worker.switchVideoTrack(data as number);
				break;
			case "switch_audio_track":
				result = await worker.switchAudioTrack(data as number);
				break;
			case "switch_subtitle_track":
				result = await worker.switchSubtitleTrack(data as number);
				break;
			case "enable_subtitles":
				result = await worker.enableSubtitles(data as boolean);
				break;
		case "extract_track": {
			const { trackType, trackIndex } = data as {
				trackType: string | number;
				trackIndex: number;
			};
			let resolvedType: number | undefined;
			if (typeof trackType === "number") {
				resolvedType = trackType;
			} else {
				const map: Record<string, number> = {
					video: 0,
					audio: 1,
					subtitle: 2,
				};
				resolvedType = map[trackType];
			}
			if (resolvedType === undefined)
				throw new Error(`Invalid track type: ${trackType}`);
			result = await worker.extractTrack(resolvedType, trackIndex);
			break;
		}
			case "get_attachment_data":
				result = await worker.getAttachmentData(data as number);
				break;
			case "extract_attachment":
				result = await worker.getAttachmentData(data as number);
				break;
			case "extract_subtitle_file":
				result = await worker.extractSubtitleFile(data as number);
				break;
			case "add_font": {
				const { filename, data: fontData } = data as {
					filename: string;
					data: Uint8Array;
				};
				result = await worker.addFont(filename, fontData);
				break;
			}
			case "load_external_subtitles": {
				const { filename, data: subData } = data as {
					filename: string;
					data: Uint8Array;
				};
				result = await worker.loadExternalSubtitles(filename, subData);
				break;
			}
			case "rebuild_subtitle_filter":
				result = await worker.rebuildSubtitleFilter();
				break;
			case "pause":
				await worker.pause();
				result = { success: true };
				break;
			case "resume":
				await worker.resume();
				result = { success: true };
				break;
			case "destroy":
				worker.destroy();
				result = { success: true };
				break;
			default:
				throw new Error(`Unknown message type: ${type}`);
		}
		self.postMessage({
			type: `${type}_result`,
			data: result,
			id,
		} satisfies WorkerResponse);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		self.postMessage({
			type: "error",
			error: errorMessage,
			id,
		} satisfies WorkerResponse);
	}
});
