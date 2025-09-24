#ifndef DECODER_COMMON_H
#define DECODER_COMMON_H

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersrc.h>
#include <libavfilter/buffersink.h>
#include <ass/ass.h>

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
    ASS_Library *ass_library;
    ASS_Renderer *ass_renderer;
    ASS_Track *ass_track;
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

    // Subtitle buffers
    uint8_t *subtitle_bitmap;
    int subtitle_bitmap_size;
    int subtitle_width;
    int subtitle_height;

    // Subtitle caching for performance
    double last_subtitle_time;
    uint8_t *cached_subtitle_bitmap;
    int cached_subtitle_size;
    int subtitle_cache_valid;

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

    // Font loading state (moved from static to prevent persistence)
    int fonts_loaded;
    int default_fonts_set;

    // Memory pool for frequent allocations
    BufferPool *buffer_pool;
} AVDecoder;

// Buffer pool management functions
BufferPool* buffer_pool_create(void);
void buffer_pool_destroy(BufferPool *pool);
uint8_t* buffer_pool_get(BufferPool *pool, int size);
void buffer_pool_release(BufferPool *pool, uint8_t *buffer);
void buffer_pool_cleanup_unused(BufferPool *pool);

// Subtitle filter functions
int decoder_render_subtitles_filter(AVDecoder *decoder, AVFrame *video_frame);

// Attachment functions (from decoder_track.c)
const char* decoder_get_attachment_info(AVDecoder *decoder, int attachment_index);
uint8_t* decoder_get_attachment_data(AVDecoder *decoder, int attachment_index);
int decoder_get_attachment_size(AVDecoder *decoder, int attachment_index);

#endif // DECODER_COMMON_H