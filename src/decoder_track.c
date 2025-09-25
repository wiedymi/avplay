#include "decoder.h"

// Streaming extraction state
typedef struct {
    AVFormatContext *output_ctx;
    AVIOContext *avio_ctx;
    uint8_t *avio_buffer;
    uint8_t *chunk_buffer;
    int chunk_size;
    int chunk_pos;
    int total_written;
    char format_name[64];
    AVDecoder *decoder;
    int stream_idx;
    AVPacket *packet;
    int extraction_done;
} StreamingExtractState;

// Global streaming state (one extraction at a time)
static StreamingExtractState *streaming_state = NULL;

// Chunk size for streaming (64KB)
#define STREAMING_CHUNK_SIZE 65536

// Forward declarations
static void cleanup_streaming_state(void);

// Helper to clean up streaming state
static void cleanup_streaming_state(void) {
    if (!streaming_state) return;

    if (streaming_state->output_ctx) {
        if (streaming_state->output_ctx->pb && !streaming_state->extraction_done) {
            av_write_trailer(streaming_state->output_ctx);
        }
        avformat_free_context(streaming_state->output_ctx);
    }

    if (streaming_state->avio_ctx) {
        av_free(streaming_state->avio_ctx);
    }

    if (streaming_state->chunk_buffer) {
        free(streaming_state->chunk_buffer);
    }

    if (streaming_state->packet) {
        av_packet_free(&streaming_state->packet);
    }

    if (streaming_state->decoder) {
        streaming_state->decoder->input_buffer_pos = 0;
        av_seek_frame(streaming_state->decoder->format_ctx, -1, 0, AVSEEK_FLAG_BACKWARD);
    }

    free(streaming_state);
    streaming_state = NULL;
}

// Callback for writing to streaming buffer
static int write_to_stream(void *opaque, const uint8_t *buf, int buf_size) {
    if (!streaming_state || !streaming_state->chunk_buffer) {
        return AVERROR(EINVAL);
    }

    // Copy data to chunk buffer for later retrieval
    int remaining = buf_size;
    const uint8_t *src = buf;

    while (remaining > 0) {
        int available = streaming_state->chunk_size - streaming_state->chunk_pos;

        // If buffer is full, expand it to accommodate more data
        if (available <= 0) {
            int new_size = streaming_state->chunk_size * 2;
            uint8_t *new_buffer = realloc(streaming_state->chunk_buffer, new_size);
            if (!new_buffer) {
                // If we can't expand, we must return error to avoid data loss
                return AVERROR(ENOMEM);
            }
            streaming_state->chunk_buffer = new_buffer;
            streaming_state->chunk_size = new_size;
            available = streaming_state->chunk_size - streaming_state->chunk_pos;
        }

        int to_copy = remaining;
        if (to_copy > available) {
            to_copy = available;
        }

        memcpy(streaming_state->chunk_buffer + streaming_state->chunk_pos, src, to_copy);
        streaming_state->chunk_pos += to_copy;
        streaming_state->total_written += to_copy;
        src += to_copy;
        remaining -= to_copy;
    }

    return buf_size;
}

// Callback for seeking in streaming buffer
static int64_t seek_in_stream(void *opaque, int64_t offset, int whence) {
    if (!streaming_state) {
        return AVERROR(EINVAL);
    }

    if (whence == AVSEEK_SIZE) {
        return streaming_state->total_written; // Return current total size
    }

    // For streaming, we only support seeking to end (for trailer writing)
    switch (whence) {
        case SEEK_SET:
            if (offset == streaming_state->total_written) {
                return streaming_state->total_written;
            }
            break;
        case SEEK_CUR:
            if (offset == 0) {
                return streaming_state->total_written;
            }
            break;
        case SEEK_END:
            if (offset == 0) {
                return streaming_state->total_written;
            }
            break;
    }

    // Other seeks not supported in streaming mode
    return -1;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_attachment_count(AVDecoder *decoder) {
    return decoder ? decoder->num_attachment_streams : 0;
}

EMSCRIPTEN_KEEPALIVE
const char* decoder_get_attachment_info(AVDecoder *decoder, int attachment_index) {
    static char info[512];
    if (!decoder || attachment_index < 0 || attachment_index >= decoder->num_attachment_streams) {
        return "Invalid attachment";
    }

    int stream_idx = decoder->attachment_streams[attachment_index];
    AVStream *stream = decoder->format_ctx->streams[stream_idx];

    AVDictionaryEntry *filename = av_dict_get(stream->metadata, "filename", NULL, 0);
    AVDictionaryEntry *mimetype = av_dict_get(stream->metadata, "mimetype", NULL, 0);

    snprintf(info, sizeof(info), "Attachment %d: %s (%s, %d bytes)",
             attachment_index + 1,
             filename ? filename->value : "unknown",
             mimetype ? mimetype->value : "unknown",
             stream->codecpar->extradata_size);

    return info;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* decoder_get_attachment_data(AVDecoder *decoder, int attachment_index) {
    if (!decoder || attachment_index < 0 || attachment_index >= decoder->num_attachment_streams) {
        return NULL;
    }

    int stream_idx = decoder->attachment_streams[attachment_index];
    AVStream *stream = decoder->format_ctx->streams[stream_idx];

    if (stream->codecpar->extradata_size > 0) {
        return stream->codecpar->extradata;
    }

    return NULL;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_attachment_size(AVDecoder *decoder, int attachment_index) {
    if (!decoder || attachment_index < 0 || attachment_index >= decoder->num_attachment_streams) {
        return 0;
    }

    int stream_idx = decoder->attachment_streams[attachment_index];
    AVStream *stream = decoder->format_ctx->streams[stream_idx];

    return stream->codecpar->extradata_size;
}

EMSCRIPTEN_KEEPALIVE
int decoder_extract_track_start(AVDecoder *decoder, int track_type, int track_index) {
    if (!decoder || !decoder->format_ctx) {
        return -1;
    }

    // Clean up any existing streaming state
    if (streaming_state) {
        cleanup_streaming_state();
    }

    int stream_idx = -1;

    if (track_type == 0) { // Video
        if (track_index < 0 || track_index >= decoder->num_video_streams) return -1;
        stream_idx = decoder->video_streams[track_index];
    } else if (track_type == 1) { // Audio
        if (track_index < 0 || track_index >= decoder->num_audio_streams) return -1;
        stream_idx = decoder->audio_streams[track_index];
    } else if (track_type == 2) { // Subtitle
        if (track_index < 0 || track_index >= decoder->num_subtitle_streams) return -1;
        stream_idx = decoder->subtitle_streams[track_index];
    } else {
        return -1;
    }

    AVStream *input_stream = decoder->format_ctx->streams[stream_idx];
    AVCodecParameters *codecpar = input_stream->codecpar;


    // Determine output format
    const AVOutputFormat *output_format = NULL;
    const char *format_name = NULL;

    if (track_type == 2) { // Subtitle
        switch (codecpar->codec_id) {
            case AV_CODEC_ID_ASS:
            case AV_CODEC_ID_SSA:
                format_name = "ass";
                break;
            case AV_CODEC_ID_SUBRIP:
            case AV_CODEC_ID_SRT:
            case AV_CODEC_ID_TEXT:
                format_name = "srt";
                break;
            case AV_CODEC_ID_WEBVTT:
                format_name = "webvtt";
                break;
            case AV_CODEC_ID_MOV_TEXT:
                format_name = "srt";
                break;
            default:
                format_name = "matroska";
                break;
        }
    } else if (track_type == 1) { // Audio
        switch (codecpar->codec_id) {
            case AV_CODEC_ID_MP3:
                format_name = "mp3";
                break;
            case AV_CODEC_ID_AAC:
                format_name = "adts";
                break;
            case AV_CODEC_ID_AC3:
                format_name = "ac3";
                break;
            case AV_CODEC_ID_FLAC:
                format_name = "flac";
                break;
            case AV_CODEC_ID_VORBIS:
                format_name = "ogg";
                break;
            case AV_CODEC_ID_OPUS:
                format_name = "opus";
                break;
            case AV_CODEC_ID_PCM_S16LE:
            case AV_CODEC_ID_PCM_S24LE:
            case AV_CODEC_ID_PCM_S32LE:
            case AV_CODEC_ID_PCM_F32LE:
                format_name = "wav";
                break;
            default:
                format_name = "matroska";
                break;
        }
    } else if (track_type == 0) { // Video
        switch (codecpar->codec_id) {
            case AV_CODEC_ID_H264:
            case AV_CODEC_ID_MPEG4:
                format_name = "matroska";
                break;
            case AV_CODEC_ID_VP8:
            case AV_CODEC_ID_VP9:
                format_name = "webm";
                break;
            case AV_CODEC_ID_AV1:
                format_name = "matroska";
                break;
            default:
                format_name = "matroska";
                break;
        }
    }

    output_format = av_guess_format(format_name, NULL, NULL);
    if (!output_format) {
        output_format = av_guess_format("matroska", NULL, NULL);
        if (!output_format) {
            return -1;
        }
    }

    // Initialize streaming state
    streaming_state = calloc(1, sizeof(StreamingExtractState));
    if (!streaming_state) {
        return -1;
    }

    streaming_state->decoder = decoder;
    streaming_state->stream_idx = stream_idx;
    streaming_state->chunk_size = STREAMING_CHUNK_SIZE;
    streaming_state->chunk_buffer = malloc(streaming_state->chunk_size);

    if (!streaming_state->chunk_buffer) {
        free(streaming_state);
        streaming_state = NULL;
        return -1;
    }

    strcpy(streaming_state->format_name, format_name ? format_name : "unknown");

    // Allocate AVIO buffer
    streaming_state->avio_buffer = (uint8_t*)av_malloc(32768);
    if (!streaming_state->avio_buffer) {
        free(streaming_state->chunk_buffer);
        free(streaming_state);
        streaming_state = NULL;
        return -1;
    }

    // Create AVIO context
    streaming_state->avio_ctx = avio_alloc_context(
        streaming_state->avio_buffer, 32768, 1, NULL, NULL,
        write_to_stream, seek_in_stream
    );

    if (!streaming_state->avio_ctx) {
        av_free(streaming_state->avio_buffer);
        free(streaming_state->chunk_buffer);
        free(streaming_state);
        streaming_state = NULL;
        return -1;
    }

    streaming_state->avio_ctx->seekable = AVIO_SEEKABLE_NORMAL; // Enable seeking for proper header/trailer handling

    // Allocate output context
    int ret = avformat_alloc_output_context2(&streaming_state->output_ctx, output_format, NULL, NULL);
    if (ret < 0 || !streaming_state->output_ctx) {
        av_free(streaming_state->avio_ctx);
        av_free(streaming_state->avio_buffer);
        free(streaming_state->chunk_buffer);
        free(streaming_state);
        streaming_state = NULL;
        return -1;
    }

    streaming_state->output_ctx->pb = streaming_state->avio_ctx;
    streaming_state->output_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

    // Create output stream
    AVStream *output_stream = avformat_new_stream(streaming_state->output_ctx, NULL);
    if (!output_stream) {
        cleanup_streaming_state();
        return -1;
    }

    // Copy codec parameters
    ret = avcodec_parameters_copy(output_stream->codecpar, input_stream->codecpar);
    if (ret < 0) {
        cleanup_streaming_state();
        return -1;
    }

    output_stream->codecpar->codec_tag = 0;
    output_stream->time_base = input_stream->time_base;

    // Write header
    ret = avformat_write_header(streaming_state->output_ctx, NULL);
    if (ret < 0) {
        cleanup_streaming_state();
        return -1;
    }

    // Allocate packet for reading
    streaming_state->packet = av_packet_alloc();
    if (!streaming_state->packet) {
        cleanup_streaming_state();
        return -1;
    }

    // Seek to beginning of input
    decoder->input_buffer_pos = 0;
    av_seek_frame(decoder->format_ctx, -1, 0, AVSEEK_FLAG_BACKWARD);

    // Return 1 to indicate success (size is unknown in streaming mode)
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int decoder_extract_track_chunk(uint8_t *buffer, int buffer_size) {
    if (!streaming_state || !buffer || buffer_size <= 0) {
        return -1;
    }

    // If we have data in chunk buffer, return it
    if (streaming_state->chunk_pos > 0) {
        int to_copy = streaming_state->chunk_pos;
        if (to_copy > buffer_size) {
            to_copy = buffer_size;
        }

        memcpy(buffer, streaming_state->chunk_buffer, to_copy);

        // Shift remaining data
        if (streaming_state->chunk_pos > to_copy) {
            memmove(streaming_state->chunk_buffer,
                   streaming_state->chunk_buffer + to_copy,
                   streaming_state->chunk_pos - to_copy);
            streaming_state->chunk_pos -= to_copy;
        } else {
            streaming_state->chunk_pos = 0;
        }

        return to_copy;
    }

    // If extraction is done, return 0
    if (streaming_state->extraction_done) {
        return 0;
    }

    // Read and process all remaining packets until EOF or buffer full
    while (streaming_state->chunk_pos < buffer_size) {
        int ret = av_read_frame(streaming_state->decoder->format_ctx, streaming_state->packet);

        if (ret < 0) {
            // End of file or error
            if (!streaming_state->extraction_done) {
                // Write trailer
                av_write_trailer(streaming_state->output_ctx);
                avio_flush(streaming_state->output_ctx->pb);
                streaming_state->extraction_done = 1;

                // Return any remaining data
                if (streaming_state->chunk_pos > 0) {
                    int to_copy = streaming_state->chunk_pos;
                    if (to_copy > buffer_size) {
                        to_copy = buffer_size;
                    }
                    memcpy(buffer, streaming_state->chunk_buffer, to_copy);
                    streaming_state->chunk_pos = 0;
                    return to_copy;
                }
            }
            return 0; // No more data
        }

        // Process packet if it's from our stream
        if (streaming_state->packet->stream_index == streaming_state->stream_idx) {
            AVStream *input_stream = streaming_state->decoder->format_ctx->streams[streaming_state->stream_idx];
            AVStream *output_stream = streaming_state->output_ctx->streams[0];

            streaming_state->packet->stream_index = 0;
            av_packet_rescale_ts(streaming_state->packet, input_stream->time_base, output_stream->time_base);
            streaming_state->packet->pos = -1;

            av_interleaved_write_frame(streaming_state->output_ctx, streaming_state->packet);

            // Flush after each packet to ensure data is written to our callback
            avio_flush(streaming_state->output_ctx->pb);
        }

        av_packet_unref(streaming_state->packet);

        // Check if we have data to return
        if (streaming_state->chunk_pos > 0) {
            break;
        }
    }

    // Return accumulated data
    if (streaming_state->chunk_pos > 0) {
        int to_copy = streaming_state->chunk_pos;
        if (to_copy > buffer_size) {
            to_copy = buffer_size;
        }

        memcpy(buffer, streaming_state->chunk_buffer, to_copy);

        // Shift remaining data
        if (streaming_state->chunk_pos > to_copy) {
            memmove(streaming_state->chunk_buffer,
                   streaming_state->chunk_buffer + to_copy,
                   streaming_state->chunk_pos - to_copy);
            streaming_state->chunk_pos -= to_copy;
        } else {
            streaming_state->chunk_pos = 0;
        }

        return to_copy;
    }

    return 0; // No data available yet
}

EMSCRIPTEN_KEEPALIVE
void decoder_extract_track_end() {
    cleanup_streaming_state();
}


