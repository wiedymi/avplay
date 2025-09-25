#include "decoder.h"

extern uint8_t* decoder_get_attachment_data(AVDecoder *decoder, int attachment_index);
extern int decoder_get_attachment_size(AVDecoder *decoder, int attachment_index);

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


static int init_subtitle_filter(AVDecoder *decoder);
static int setup_extracted_subtitle_file_for_filter(AVDecoder *decoder);

extern int decoder_extract_track_start(AVDecoder *decoder, int track_type, int track_index);
extern int decoder_extract_track_chunk(uint8_t *buffer, int buffer_size);
extern void decoder_extract_track_end();

// Subtitle track info functions
EMSCRIPTEN_KEEPALIVE
int decoder_get_subtitle_track_count(AVDecoder *decoder) {
    return decoder ? decoder->num_subtitle_streams : 0;
}

EMSCRIPTEN_KEEPALIVE
const char* decoder_get_subtitle_track_info(AVDecoder *decoder, int track_index) {
    static char info[512];
    if (!decoder || track_index < 0 || track_index >= decoder->num_subtitle_streams) {
        return "Invalid track";
    }

    int stream_idx = decoder->subtitle_streams[track_index];
    AVStream *stream = decoder->format_ctx->streams[stream_idx];
    AVCodecParameters *codecpar = stream->codecpar;

    const AVCodec *codec = avcodec_find_decoder(codecpar->codec_id);
    const char *codec_name = codec ? codec->name : "unknown";

    AVDictionaryEntry *lang = av_dict_get(stream->metadata, "language", NULL, 0);
    AVDictionaryEntry *title = av_dict_get(stream->metadata, "title", NULL, 0);
    const char *language = lang ? lang->value : "unknown";
    const char *track_title = title ? title->value : "";

    if (strlen(track_title) > 0) {
        snprintf(info, sizeof(info), "Track %d: %s [%s] \"%s\"",
                 track_index + 1, codec_name, language, track_title);
    } else {
        snprintf(info, sizeof(info), "Track %d: %s [%s]",
                 track_index + 1, codec_name, language);
    }

    return info;
}

EMSCRIPTEN_KEEPALIVE
int init_subtitle_decoder(AVDecoder *decoder) {
    if (!decoder) return -1;


    decoder->use_filter_rendering = 1;
    decoder->subtitle_filter_graph = NULL;
    decoder->subtitle_buffersrc_ctx = NULL;
    decoder->subtitle_buffersink_ctx = NULL;
    decoder->subtitle_file_path = NULL;

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int decoder_switch_subtitle_track(AVDecoder *decoder, int track_index) {
    if (!decoder || track_index < 0 || track_index >= decoder->num_subtitle_streams) {
        return -1;
    }

    decoder->selected_subtitle_stream = track_index;
    int stream_idx = decoder->subtitle_streams[track_index];
    decoder->subtitle_stream_idx = stream_idx;

    if (decoder->subtitle_enabled && decoder->use_filter_rendering) {

        if (decoder->subtitle_filter_graph) {
            avfilter_graph_free(&decoder->subtitle_filter_graph);
            decoder->subtitle_filter_graph = NULL;
            decoder->subtitle_buffersrc_ctx = NULL;
            decoder->subtitle_buffersink_ctx = NULL;
        }

        if (decoder->subtitle_file_path) {
            remove(decoder->subtitle_file_path);
            free(decoder->subtitle_file_path);
            decoder->subtitle_file_path = NULL;
        }

        if (setup_extracted_subtitle_file_for_filter(decoder) < 0) {
            decoder->use_filter_rendering = 0;
            return -1;
        } else if (init_subtitle_filter(decoder) < 0) {
            decoder->use_filter_rendering = 0;
            return -1;
        } else {
        }
    }

    if (decoder->current_position > 0.0) {
        decoder_seek(decoder, decoder->current_position);
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int decoder_enable_filter_subtitles(AVDecoder *decoder, int enabled) {
    if (!decoder) return -1;


    if (enabled) {
        // Initialize subtitle decoder on first enable (lazy initialization)
        if (decoder->num_subtitle_streams > 0 && decoder->subtitle_filter_graph == NULL) {
            init_subtitle_decoder(decoder);
        }
    }

    decoder->subtitle_enabled = enabled;
    decoder->use_filter_rendering = enabled;

    if (enabled) {

        if (!decoder->subtitle_filter_graph) {
            if (setup_extracted_subtitle_file_for_filter(decoder) < 0) {
                return -1;
            }

            if (init_subtitle_filter(decoder) < 0) {
                return -1;
            }
        }
    } else {
        if (decoder->subtitle_filter_graph) {
            avfilter_graph_free(&decoder->subtitle_filter_graph);
            decoder->subtitle_filter_graph = NULL;
            decoder->subtitle_buffersrc_ctx = NULL;
            decoder->subtitle_buffersink_ctx = NULL;
        }

        if (decoder->subtitle_file_path) {
            remove(decoder->subtitle_file_path);
            free(decoder->subtitle_file_path);
            decoder->subtitle_file_path = NULL;
        }
    }

    return 0;
}

static int init_subtitle_filter(AVDecoder *decoder) {
    if (!decoder || !decoder->subtitle_file_path) {
        return -1;
    }


    decoder->subtitle_filter_graph = avfilter_graph_alloc();
    if (!decoder->subtitle_filter_graph) {
        return -1;
    }

    int video_width = decoder->video_codec_ctx ? decoder->video_codec_ctx->width : 1920;
    int video_height = decoder->video_codec_ctx ? decoder->video_codec_ctx->height : 1080;
    enum AVPixelFormat pix_fmt = decoder->video_codec_ctx ? decoder->video_codec_ctx->pix_fmt : AV_PIX_FMT_YUV420P;
    AVRational time_base = decoder->format_ctx->streams[decoder->video_stream_idx]->time_base;

    fprintf(stderr, "DEBUG: Setting up subtitle filter - size:%dx%d, pix_fmt:%d\n",
            video_width, video_height, pix_fmt);

    char args[512];
    snprintf(args, sizeof(args),
             "video_size=%dx%d:pix_fmt=%d:time_base=%d/%d:pixel_aspect=%d/%d",
             video_width, video_height,
             pix_fmt,
             time_base.num, time_base.den,
             1, 1);

    const AVFilter *buffersrc = avfilter_get_by_name("buffer");
    int ret = avfilter_graph_create_filter(&decoder->subtitle_buffersrc_ctx,
                                           buffersrc, "in", args, NULL,
                                           decoder->subtitle_filter_graph);
    if (ret < 0) {
        avfilter_graph_free(&decoder->subtitle_filter_graph);
        return -1;
    }

    const AVFilter *buffersink = avfilter_get_by_name("buffersink");
    ret = avfilter_graph_create_filter(&decoder->subtitle_buffersink_ctx,
                                       buffersink, "out", NULL, NULL,
                                       decoder->subtitle_filter_graph);
    if (ret < 0) {
        avfilter_graph_free(&decoder->subtitle_filter_graph);
        return -1;
    }

    AVFilterContext *subtitle_filter_ctx = NULL;
    const AVFilter *subtitle_filter = avfilter_get_by_name("subtitles");

    char subtitle_args[1024];
    snprintf(subtitle_args, sizeof(subtitle_args),
             "filename=%s:fontsdir=/tmp/fonts", decoder->subtitle_file_path);

    ret = avfilter_graph_create_filter(&subtitle_filter_ctx,
                                       subtitle_filter, "subtitles",
                                       subtitle_args, NULL,
                                       decoder->subtitle_filter_graph);
    if (ret < 0) {
        avfilter_graph_free(&decoder->subtitle_filter_graph);
        return -1;
    }

    ret = avfilter_link(decoder->subtitle_buffersrc_ctx, 0, subtitle_filter_ctx, 0);
    if (ret < 0) {
        avfilter_graph_free(&decoder->subtitle_filter_graph);
        return -1;
    }

    ret = avfilter_link(subtitle_filter_ctx, 0, decoder->subtitle_buffersink_ctx, 0);
    if (ret < 0) {
        avfilter_graph_free(&decoder->subtitle_filter_graph);
        return -1;
    }

    ret = avfilter_graph_config(decoder->subtitle_filter_graph, NULL);
    if (ret < 0) {
        avfilter_graph_free(&decoder->subtitle_filter_graph);
        return -1;
    }

    return 0;
}

static int setup_extracted_subtitle_file_for_filter(AVDecoder *decoder) {
    if (!decoder) return -1;

    // Start streaming extraction
    int result = decoder_extract_track_start(decoder, 2, decoder->selected_subtitle_stream);
    if (result <= 0) {
        return -1;
    }

    decoder->subtitle_file_path = strdup("/tmp/subtitles.ass");
    FILE *temp_file = fopen(decoder->subtitle_file_path, "wb");
    if (!temp_file) {
        free(decoder->subtitle_file_path);
        decoder->subtitle_file_path = NULL;
        decoder_extract_track_end();
        return -1;
    }

    // Stream data directly to file
    uint8_t buffer[65536]; // 64KB buffer
    int total_written = 0;
    int chunk_size;

    while ((chunk_size = decoder_extract_track_chunk(buffer, sizeof(buffer))) > 0) {
        size_t written = fwrite(buffer, 1, chunk_size, temp_file);
        if (written != chunk_size) {
            fclose(temp_file);
            remove(decoder->subtitle_file_path);
            free(decoder->subtitle_file_path);
            decoder->subtitle_file_path = NULL;
            decoder_extract_track_end();
            return -1;
        }
        total_written += written;
    }

    fclose(temp_file);

    // Clean up streaming state
    decoder_extract_track_end();

    // Check if we got any data
    if (total_written <= 0) {
        remove(decoder->subtitle_file_path);
        free(decoder->subtitle_file_path);
        decoder->subtitle_file_path = NULL;
        return -1;
    }

    // Create fonts directory using Emscripten FS
    EM_ASM({
        try {
            FS.mkdir('/tmp');
        } catch(e) {
            // Directory might already exist
        }
        try {
            FS.mkdir('/tmp/fonts');
        } catch(e) {
            // Directory might already exist
        }
    });

    // Extract font attachments only if not already done (cache fonts)
    if (!decoder->fonts_loaded) {
        fprintf(stderr, "DEBUG: Extracting %d font attachments...\n", decoder->num_attachment_streams);

        for (int i = 0; i < decoder->num_attachment_streams; i++) {
            uint8_t *font_data = decoder_get_attachment_data(decoder, i);
            int font_size = decoder_get_attachment_size(decoder, i);

            if (font_data && font_size > 0) {
                // Get attachment info to determine filename
                int stream_idx = decoder->attachment_streams[i];
                AVStream *stream = decoder->format_ctx->streams[stream_idx];
                AVDictionaryEntry *filename_entry = av_dict_get(stream->metadata, "filename", NULL, 0);

                char font_path[512];
                if (filename_entry && filename_entry->value) {
                    snprintf(font_path, sizeof(font_path), "/tmp/fonts/%s", filename_entry->value);
                } else {
                    // Generate filename from attachment index
                    snprintf(font_path, sizeof(font_path), "/tmp/fonts/font_%d.ttf", i);
                }

                // Write font file
                FILE *font_file = fopen(font_path, "wb");
                if (font_file) {
                    size_t written = fwrite(font_data, 1, font_size, font_file);
                    fclose(font_file);

                    if (written != font_size) {
                        // Silent fail - don't spam logs
                    }
                } else {
                    // Silent fail - don't spam logs
                }
            }
        }

        decoder->fonts_loaded = 1; // Cache flag to prevent re-extraction
        fprintf(stderr, "DEBUG: Font extraction completed, %d fonts cached\n", decoder->num_attachment_streams);
    } else {
        fprintf(stderr, "DEBUG: Fonts already loaded, skipping extraction\n");
    }

    fprintf(stderr, "DEBUG: Subtitle file setup complete: %s (%d bytes)\n",
            decoder->subtitle_file_path, total_written);
    return 0;
}

int decoder_render_subtitles_filter(AVDecoder *decoder, AVFrame *video_frame) {
    static int call_count = 0;
    static double total_time = 0.0;
    struct timeval start_time, end_time;

    if (!decoder || !video_frame) {
        return -1;
    }

    // Performance monitoring
    gettimeofday(&start_time, NULL);

    if (!decoder->subtitle_filter_graph || !decoder->subtitle_buffersrc_ctx || !decoder->subtitle_buffersink_ctx) {
        return -1;
    }

    // Quick check: skip expensive processing if frame has no timestamp
    if (video_frame->pts == AV_NOPTS_VALUE) {
        return 0; // Skip subtitle processing for frames without timing
    }

    // Calculate current timestamp for subtitle caching
    double current_time = 0.0;
    if (decoder->frame_timestamp > 0) {
        current_time = decoder->frame_timestamp;
    } else if (video_frame->pts != AV_NOPTS_VALUE) {
        AVStream *video_stream = decoder->format_ctx->streams[decoder->video_stream_idx];
        if (video_stream && video_stream->time_base.den > 0) {
            current_time = video_frame->pts * av_q2d(video_stream->time_base);
        }
    }

    // Simple subtitle caching - skip if timestamp hasn't changed significantly
    static double last_subtitle_time = -1.0;
    static int subtitle_cache_valid = 0;

    if (fabs(current_time - last_subtitle_time) < 0.040) { // 40ms tolerance
        if (subtitle_cache_valid) {
            return 0; // Use cached result, no processing needed
        }
    } else {
        last_subtitle_time = current_time;
        subtitle_cache_valid = 0;
    }

    // Add frame to subtitle filter - use KEEP_REF to avoid corruption
    int ret = av_buffersrc_add_frame_flags(decoder->subtitle_buffersrc_ctx, video_frame, AV_BUFFERSRC_FLAG_KEEP_REF);
    if (ret < 0) {
        return -1;
    }

    // Try to get filtered frame
    AVFrame *filtered_frame = av_frame_alloc();
    if (!filtered_frame) {
        return -1;
    }

    ret = av_buffersink_get_frame(decoder->subtitle_buffersink_ctx, filtered_frame);
    if (ret < 0) {
        av_frame_free(&filtered_frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            // No subtitle at this timestamp - cache this result
            subtitle_cache_valid = 1;
            return 0;
        } else {
            return -1;
        }
    }

    // Copy the filtered frame back to the original frame - use ownership transfer
    if (filtered_frame->format == video_frame->format &&
        filtered_frame->width == video_frame->width &&
        filtered_frame->height == video_frame->height) {

        // Transfer ownership: unref original buffers, move filtered buffers to video_frame
        av_frame_unref(video_frame);
        av_frame_move_ref(video_frame, filtered_frame);
        // av_frame_move_ref doesn't return error code - it always succeeds

        subtitle_cache_valid = 1; // Mark cache as valid
        av_frame_free(&filtered_frame); // Safe: filtered_frame is now empty after move_ref

        // Performance logging
        gettimeofday(&end_time, NULL);
        double frame_time = (end_time.tv_sec - start_time.tv_sec) * 1000.0 +
                           (end_time.tv_usec - start_time.tv_usec) / 1000.0;
        total_time += frame_time;
        call_count++;

        if (call_count % 100 == 0) {
            fprintf(stderr, "PERF: Subtitle rendering - %d frames, avg: %.2fms/frame\n",
                   call_count, total_time / call_count);
        }

        return 0;
    } else {
        av_frame_free(&filtered_frame);
        return -1;
    }
}

