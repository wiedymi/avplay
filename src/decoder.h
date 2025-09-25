#ifndef DECODER_H
#define DECODER_H

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libavutil/log.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersrc.h>
#include <libavfilter/buffersink.h>
#include <libavutil/error.h>
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <sys/time.h>

// Performance logging macros
#define PERF_START(name) \
    struct timeval perf_start_##name, perf_end_##name; \
    gettimeofday(&perf_start_##name, NULL); \
    fprintf(stderr, "PERF_START: %s\n", #name);

#define PERF_END(name) \
    gettimeofday(&perf_end_##name, NULL); \
    long perf_diff_##name = (perf_end_##name.tv_sec - perf_start_##name.tv_sec) * 1000000 + \
                           (perf_end_##name.tv_usec - perf_start_##name.tv_usec); \
    fprintf(stderr, "PERF_END: %s took %ld μs (%.3f ms)\n", #name, perf_diff_##name, perf_diff_##name / 1000.0);

#define PERF_LOG(msg, ...) fprintf(stderr, "PERF_LOG: " msg "\n", ##__VA_ARGS__);

#define MAX_EXTRACT_BUFFER_SIZE (500*1024*1024) // 500MB max for video extraction

// Memory pool for frequent allocations
#define BUFFER_POOL_SIZE 4
#define SMALL_BUFFER_SIZE (1024 * 1024)     // 1MB
#define MEDIUM_BUFFER_SIZE (5 * 1024 * 1024) // 5MB
#define LARGE_BUFFER_SIZE (20 * 1024 * 1024) // 20MB

typedef struct {
    uint8_t *data;
    int size;
    int in_use;
} PooledBuffer;

typedef struct {
    PooledBuffer small_buffers[BUFFER_POOL_SIZE];
    PooledBuffer medium_buffers[BUFFER_POOL_SIZE];
    PooledBuffer large_buffers[BUFFER_POOL_SIZE];
    int initialized;
} BufferPool;

typedef struct {
    // Format context
    AVFormatContext *format_ctx;

    // Video decoding
    AVCodecContext *video_codec_ctx;
    const AVCodec *video_codec;
    int video_stream_idx;
    int selected_video_stream;
    struct SwsContext *sws_ctx;

    // Audio decoding
    AVCodecContext *audio_codec_ctx;
    const AVCodec *audio_codec;
    int audio_stream_idx;
    int selected_audio_stream;
    struct SwrContext *swr_ctx;

    // Subtitle decoding and rendering
    AVCodecContext *subtitle_codec_ctx;
    const AVCodec *subtitle_codec;
    int subtitle_stream_idx;
    int selected_subtitle_stream;
    int subtitle_enabled;

    // Subtitle filtering (libavfilter approach)
    AVFilterGraph *subtitle_filter_graph;
    AVFilterContext *subtitle_buffersrc_ctx;
    AVFilterContext *subtitle_buffersink_ctx;
    char *subtitle_file_path;
    int use_filter_rendering;

    // Common
    AVPacket *packet;
    AVFrame *frame;

    // Video buffers
    uint8_t *rgb_buffer;
    int rgb_buffer_size;

    // Audio buffers
    uint8_t *audio_buffer;
    int audio_buffer_size;
    int audio_buffer_pos;


    // Input buffer
    uint8_t *input_buffer;
    int input_buffer_size;
    int input_buffer_pos;

    // Audio parameters
    int audio_sample_rate;
    int audio_channels;
    int audio_samples_per_frame;

    // Track lists
    int *video_streams;
    int *audio_streams;
    int *subtitle_streams;
    int *attachment_streams;
    int num_video_streams;
    int num_audio_streams;
    int num_subtitle_streams;
    int num_attachment_streams;

    // Error handling
    int error_count;
    int max_errors;

    // Font loading state
    int fonts_loaded;
    int default_fonts_set;

    // Current playback position tracking
    double current_position;
    double frame_timestamp; // PTS timestamp of current frame
    int frame_count; // Frame counter for timing calculations

    // Memory pool for frequent allocations
    BufferPool *buffer_pool;
} AVDecoder;

// Track extraction buffer (shared across modules)
extern uint8_t *track_extract_buffer;
extern int track_extract_buffer_size;
extern int track_extract_buffer_capacity;
extern char track_extract_format_name[64];

// Internal helper functions
int read_packet_callback(void *opaque, uint8_t *buf, int buf_size);
int64_t seek_callback(void *opaque, int64_t offset, int whence);
int write_to_buffer(void *opaque, const uint8_t *buf, int buf_size);
int64_t seek_in_buffer(void *opaque, int64_t offset, int whence);

// Buffer pool management functions
BufferPool* buffer_pool_create(void);
void buffer_pool_destroy(BufferPool *pool);
uint8_t* buffer_pool_get(BufferPool *pool, int size);
void buffer_pool_release(BufferPool *pool, uint8_t *buffer);
void buffer_pool_cleanup_unused(BufferPool *pool);
int decoder_init_buffer_pool(AVDecoder *decoder);
void decoder_cleanup_buffer_pool(AVDecoder *decoder);

// Core decoder functions
int decoder_seek(AVDecoder *decoder, double time_seconds);

// Threading control functions
int decoder_set_thread_count(AVDecoder *decoder, int count);
int decoder_get_thread_count(AVDecoder *decoder);

// External assets APIs
// Add a custom font file to the runtime fonts directory used by the subtitles filter
int decoder_add_font(AVDecoder *decoder, const char *filename, uint8_t *data, int size);
// Load external subtitles (e.g., .ass, .srt, .vtt) and rebuild the filter graph
int decoder_load_external_subtitles(AVDecoder *decoder, const char *filename, uint8_t *data, int size);
// Rebuild subtitle filter graph using current decoder->subtitle_file_path
int decoder_rebuild_subtitle_filter(AVDecoder *decoder);

#endif // DECODER_H
