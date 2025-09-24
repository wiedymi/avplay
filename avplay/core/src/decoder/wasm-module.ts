export interface WASMModule {
	// Core Emscripten functions
	cwrap: (
		name: string,
		returnType: string,
		argTypes: string[],
	) => (...args: unknown[]) => unknown;
	ccall: (
		name: string,
		returnType: string | null,
		argTypes: string[],
		args: unknown[],
	) => unknown;
	_malloc: (size: number) => number;
	_free: (ptr: number) => void;

	// Memory views
	HEAPU8: Uint8Array;
	HEAPF32: Float32Array;
	HEAP8: Int8Array;
	HEAP16: Int16Array;
	HEAPU16: Uint16Array;
	HEAP32: Int32Array;
	HEAPU32: Uint32Array;
	HEAPF64: Float64Array;

	// Runtime callbacks
	onRuntimeInitialized?: () => void;
}

export interface DecoderCAPI {
	// Direct ccall access like the working demo
	ccall: (
		name: string,
		returnType: string | null,
		argTypes: string[],
		args: unknown[],
	) => unknown;

	// Memory management
	malloc: (size: number) => number;
	free: (ptr: number) => void;
	HEAPU8: Uint8Array;
	HEAPF32: Float32Array;
	Module: WASMModule;
}

declare global {
	const createDecoderModule: () => Promise<WASMModule>;
}
