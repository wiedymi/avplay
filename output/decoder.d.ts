// TypeScript bindings for emscripten-generated code.  Automatically generated at compile time.
declare namespace RuntimeExports {
    /**
     * @param {string|null=} returnType
     * @param {Array=} argTypes
     * @param {Array=} args
     * @param {Object=} opts
     */
    function ccall(ident: any, returnType?: (string | null) | undefined, argTypes?: any[] | undefined, args?: any[] | undefined, opts?: any | undefined): any;
    /**
     * @param {string=} returnType
     * @param {Array=} argTypes
     * @param {Object=} opts
     */
    function cwrap(ident: any, returnType?: string | undefined, argTypes?: any[] | undefined, opts?: any | undefined): any;
    /**
     * @param {number} ptr
     * @param {string} type
     */
    function getValue(ptr: number, type?: string): any;
    /**
     * @param {number} ptr
     * @param {number} value
     * @param {string} type
     */
    function setValue(ptr: number, value: number, type?: string): void;
    function stringToUTF8(str: any, outPtr: any, maxBytesToWrite: any): any;
    function lengthBytesUTF8(str: any): number;
    let HEAP8: any;
    let HEAPU8: any;
    let HEAPF32: any;
}
interface WasmModule {
  _decoder_create(): number;
  _free(_0: number): void;
  _decoder_init_sync(_0: number): number;
  _decoder_init_format(_0: number, _1: number, _2: number): number;
  _malloc(_0: number): number;
  _decoder_destroy(_0: number): void;
  _decoder_cleanup_sync(_0: number): void;
  _decoder_seek(_0: number, _1: number): number;
  _decoder_get_duration(_0: number): number;
  _decoder_get_codec_name(_0: number): number;
  _decoder_get_version(): number;
  _decoder_set_thread_count(_0: number, _1: number): number;
  _decoder_get_thread_count(_0: number): number;
  _decoder_get_sync_stats(_0: number): number;
  _decoder_get_audio_buffer_health(_0: number): number;
  _decoder_audio_needs_more_data(_0: number): number;
  _decoder_decode_frame(_0: number): number;
  _decoder_get_width(_0: number): number;
  _decoder_get_height(_0: number): number;
  _decoder_get_frame_rgb(_0: number): number;
  _decoder_render_subtitles_filter(_0: number, _1: number): number;
  _decoder_get_video_track_count(_0: number): number;
  _decoder_get_video_track_info(_0: number, _1: number): number;
  _decoder_get_frame_timestamp(_0: number): number;
  _decoder_switch_video_track(_0: number, _1: number): number;
  _decoder_has_audio(_0: number): number;
  _decoder_get_audio_sample_rate(_0: number): number;
  _decoder_get_audio_channels(_0: number): number;
  _decoder_get_audio_buffer_size(_0: number): number;
  _decoder_get_audio_buffer(_0: number): number;
  _decoder_clear_audio_buffer(_0: number): void;
  _decoder_get_audio_codec_name(_0: number): number;
  _decoder_get_audio_track_count(_0: number): number;
  _decoder_get_audio_track_info(_0: number, _1: number): number;
  _decoder_switch_audio_track(_0: number, _1: number): number;
  _decoder_get_subtitle_track_count(_0: number): number;
  _decoder_get_subtitle_track_info(_0: number, _1: number): number;
  _init_subtitle_decoder(_0: number): number;
  _decoder_switch_subtitle_track(_0: number, _1: number): number;
  _decoder_enable_filter_subtitles(_0: number, _1: number): number;
  _decoder_extract_track_start(_0: number, _1: number, _2: number): number;
  _decoder_extract_track_end(): void;
  _decoder_extract_track_chunk(_0: number, _1: number): number;
  _decoder_get_attachment_data(_0: number, _1: number): number;
  _decoder_get_attachment_size(_0: number, _1: number): number;
  _decoder_get_attachment_count(_0: number): number;
  _decoder_get_attachment_info(_0: number, _1: number): number;
  _emscripten_builtin_free(_0: number): void;
  ___libc_free(_0: number): void;
  _emscripten_builtin_malloc(_0: number): number;
  ___libc_malloc(_0: number): number;
  __ZdaPv(_0: number): void;
  __ZdaPvm(_0: number, _1: number): void;
  __ZdlPv(_0: number): void;
  __ZdlPvm(_0: number, _1: number): void;
  __Znaj(_0: number): number;
  __ZnajSt11align_val_t(_0: number, _1: number): number;
  __Znwj(_0: number): number;
  __ZnwjSt11align_val_t(_0: number, _1: number): number;
  ___libc_calloc(_0: number, _1: number): number;
  ___libc_realloc(_0: number, _1: number): number;
  _emscripten_builtin_calloc(_0: number, _1: number): number;
  _emscripten_builtin_realloc(_0: number, _1: number): number;
  _malloc_size(_0: number): number;
  _malloc_usable_size(_0: number): number;
  _reallocf(_0: number, _1: number): number;
}

export type MainModule = WasmModule & typeof RuntimeExports;
export default function MainModuleFactory (options?: unknown): Promise<MainModule>;
