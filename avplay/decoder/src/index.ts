export type { FileInfo, FrameData } from "./types";

// Helper to get the CDN base URL for this decoder version
// Consumers can use these defaults or override via @avplay/core assets option
import pkg from "../package.json";

export function getCdnBaseUrl(): string {
	const version = typeof pkg?.version === "string" ? pkg.version : "";
	const suffix = version ? `@${version}` : "";
	return `https://unpkg.com/@avplay/decoder${suffix}/dist`;
}

export function getDecoderScriptUrl(): string {
	return `${getCdnBaseUrl()}/decoder.js`;
}

export function getDecoderWorkerUrl(): string {
	return `${getCdnBaseUrl()}/decoder-worker.js`;
}
