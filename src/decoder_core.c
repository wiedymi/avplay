#include "decoder.h"

extern int init_subtitle_decoder(AVDecoder *decoder);

EMSCRIPTEN_KEEPALIVE
AVDecoder* decoder_create() {
    AVDecoder *decoder = (AVDecoder*)calloc(1, sizeof(AVDecoder));
    if (!decoder) return NULL;

    decoder->packet = av_packet_alloc();
    decoder->frame = av_frame_alloc();
    decoder->video_stream_idx = -1;
    decoder->audio_stream_idx = -1;
    decoder->subtitle_stream_idx = -1;
    decoder->selected_video_stream = 0;
    decoder->selected_audio_stream = 0;
    decoder->selected_subtitle_stream = 0;
    decoder->subtitle_enabled = 0; // Match JavaScript default state
    decoder->max_errors = 10;
    decoder->error_count = 0;
    decoder->frame_timestamp = 0.0;
    decoder->frame_count = 0;

    // Initialize audio buffer size (1.0 seconds of stereo 48kHz float samples)
    decoder->audio_buffer_size = 48000 * 2 * sizeof(float) * 2; // ~768KB

    decoder->buffer_pool = NULL;

    if (!decoder->packet || !decoder->frame) {
        if (decoder->packet) av_packet_free(&decoder->packet);
        if (decoder->frame) av_frame_free(&decoder->frame);
        free(decoder);
        return NULL;
    }

    // Initialize buffer pool for performance
    decoder_init_buffer_pool(decoder);

    return decoder;
}

EMSCRIPTEN_KEEPALIVE
int decoder_init_format(AVDecoder *decoder, uint8_t *data, int size) {

    if (!decoder || !data) return -1;

    decoder->input_buffer = data;
    decoder->input_buffer_size = size;
    decoder->input_buffer_pos = 0;

    unsigned char *avio_buffer = (unsigned char *)av_malloc(65536);
    if (!avio_buffer) {
        return -1;
    }

    AVIOContext *avio_ctx = avio_alloc_context(avio_buffer, 65536, 0, decoder,
                                                read_packet_callback, NULL, seek_callback);
    if (!avio_ctx) {
        av_free(avio_buffer);
        return -1;
    }
    avio_ctx->seekable = AVIO_SEEKABLE_NORMAL;

    decoder->format_ctx = avformat_alloc_context();
    if (!decoder->format_ctx) {
        av_free(avio_buffer);
        avio_context_free(&avio_ctx);
        return -1;
    }

    decoder->format_ctx->pb = avio_ctx;

    if (avformat_open_input(&decoder->format_ctx, NULL, NULL, NULL) < 0) {
        av_free(avio_buffer);
        avio_context_free(&avio_ctx);
        return -1;
    }

    if (avformat_find_stream_info(decoder->format_ctx, NULL) < 0) {
        avformat_close_input(&decoder->format_ctx);
        return -1;
    }

    decoder->num_video_streams = 0;
    decoder->num_audio_streams = 0;
    decoder->num_subtitle_streams = 0;
    decoder->num_attachment_streams = 0;

    for (unsigned int i = 0; i < decoder->format_ctx->nb_streams; i++) {
        AVStream *stream = decoder->format_ctx->streams[i];
        if (stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            decoder->num_video_streams++;
        } else if (stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            decoder->num_audio_streams++;
        } else if (stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
            decoder->num_subtitle_streams++;
        } else if (stream->codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
            decoder->num_attachment_streams++;
        }
    }

    if (decoder->num_video_streams > 0) {
        decoder->video_streams = (int*)calloc(decoder->num_video_streams, sizeof(int));
        if (!decoder->video_streams) {
            avformat_close_input(&decoder->format_ctx);
            return -1;
        }
    }
    if (decoder->num_audio_streams > 0) {
        decoder->audio_streams = (int*)calloc(decoder->num_audio_streams, sizeof(int));
        if (!decoder->audio_streams) {
            if (decoder->video_streams) free(decoder->video_streams);
            avformat_close_input(&decoder->format_ctx);
            return -1;
        }
    }
    if (decoder->num_subtitle_streams > 0) {
        decoder->subtitle_streams = (int*)calloc(decoder->num_subtitle_streams, sizeof(int));
        if (!decoder->subtitle_streams) {
            if (decoder->video_streams) free(decoder->video_streams);
            if (decoder->audio_streams) free(decoder->audio_streams);
            avformat_close_input(&decoder->format_ctx);
            return -1;
        }
    }
    if (decoder->num_attachment_streams > 0) {
        decoder->attachment_streams = (int*)calloc(decoder->num_attachment_streams, sizeof(int));
        if (!decoder->attachment_streams) {
            if (decoder->video_streams) free(decoder->video_streams);
            if (decoder->audio_streams) free(decoder->audio_streams);
            if (decoder->subtitle_streams) free(decoder->subtitle_streams);
            avformat_close_input(&decoder->format_ctx);
            return -1;
        }
    }

    int video_idx = 0, audio_idx = 0, subtitle_idx = 0, attachment_idx = 0;
    for (unsigned int i = 0; i < decoder->format_ctx->nb_streams; i++) {
        AVStream *stream = decoder->format_ctx->streams[i];

        if (stream->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            decoder->video_streams[video_idx++] = i;

            if (decoder->video_stream_idx == -1) {
                decoder->video_stream_idx = i;

                decoder->video_codec = avcodec_find_decoder(stream->codecpar->codec_id);
                if (!decoder->video_codec) {
                    continue;
                }

                decoder->video_codec_ctx = avcodec_alloc_context3(decoder->video_codec);
                if (!decoder->video_codec_ctx) continue;

                if (avcodec_parameters_to_context(decoder->video_codec_ctx, stream->codecpar) < 0) {
                    avcodec_free_context(&decoder->video_codec_ctx);
                    continue;
                }

                AVDictionary *opts = NULL;

                // Configure threading for video decoding
                decoder->video_codec_ctx->thread_count = 0; // 0 = auto-detect optimal thread count
                decoder->video_codec_ctx->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE; // Enable both frame and slice threading

                if (stream->codecpar->codec_id == AV_CODEC_ID_AV1) {
                    if (decoder->video_codec_ctx->pix_fmt == AV_PIX_FMT_NONE) {
                        decoder->video_codec_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
                    }
                    av_dict_set(&opts, "strict", "experimental", 0);
                    av_dict_set(&opts, "err_detect", "careful", 0);
                }

                if (avcodec_open2(decoder->video_codec_ctx, decoder->video_codec, &opts) < 0) {
                    av_dict_free(&opts);
                    avcodec_free_context(&decoder->video_codec_ctx);
                    continue;
                }
                av_dict_free(&opts);
            }
        } else if (stream->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            decoder->audio_streams[audio_idx++] = i;

            if (decoder->audio_stream_idx == -1) {
                decoder->audio_stream_idx = i;

                decoder->audio_codec = avcodec_find_decoder(stream->codecpar->codec_id);
                if (!decoder->audio_codec) {
                    continue;
                }

                decoder->audio_codec_ctx = avcodec_alloc_context3(decoder->audio_codec);
                if (!decoder->audio_codec_ctx) continue;

                if (avcodec_parameters_to_context(decoder->audio_codec_ctx, stream->codecpar) < 0) {
                    avcodec_free_context(&decoder->audio_codec_ctx);
                    continue;
                }

                // Configure threading for audio decoding
                decoder->audio_codec_ctx->thread_count = 0; // 0 = auto-detect
                decoder->audio_codec_ctx->thread_type = FF_THREAD_FRAME;

                if (avcodec_open2(decoder->audio_codec_ctx, decoder->audio_codec, NULL) < 0) {
                    avcodec_free_context(&decoder->audio_codec_ctx);
                    continue;
                }

                decoder->audio_sample_rate = decoder->audio_codec_ctx->sample_rate;
                decoder->audio_channels = decoder->audio_codec_ctx->ch_layout.nb_channels;

                decoder->swr_ctx = swr_alloc();
                if (decoder->swr_ctx) {
                    av_opt_set_chlayout(decoder->swr_ctx, "in_chlayout", &decoder->audio_codec_ctx->ch_layout, 0);
                    av_opt_set_int(decoder->swr_ctx, "in_sample_rate", decoder->audio_codec_ctx->sample_rate, 0);
                    av_opt_set_sample_fmt(decoder->swr_ctx, "in_sample_fmt", decoder->audio_codec_ctx->sample_fmt, 0);

                    AVChannelLayout out_ch_layout = AV_CHANNEL_LAYOUT_STEREO;
                    av_opt_set_chlayout(decoder->swr_ctx, "out_chlayout", &out_ch_layout, 0);
                    av_opt_set_int(decoder->swr_ctx, "out_sample_rate", decoder->audio_codec_ctx->sample_rate, 0);
                    av_opt_set_sample_fmt(decoder->swr_ctx, "out_sample_fmt", AV_SAMPLE_FMT_FLT, 0);

                    av_opt_set_int(decoder->swr_ctx, "filter_type", SWR_FILTER_TYPE_KAISER, 0);
                    av_opt_set_int(decoder->swr_ctx, "kaiser_beta", 9, 0);
                    av_opt_set_double(decoder->swr_ctx, "cutoff", 0.95, 0);

                    swr_init(decoder->swr_ctx);

                    decoder->audio_buffer = (uint8_t*)malloc(decoder->audio_buffer_size);
                    if (!decoder->audio_buffer) {
                        swr_free(&decoder->swr_ctx);
                        avcodec_free_context(&decoder->audio_codec_ctx);
                        continue;
                    }
                    decoder->audio_buffer_pos = 0;
                }
            }
        } else if (stream->codecpar->codec_type == AVMEDIA_TYPE_SUBTITLE) {
            decoder->subtitle_streams[subtitle_idx++] = i;

            if (decoder->subtitle_stream_idx == -1) {
                decoder->subtitle_stream_idx = i;
            }
        } else if (stream->codecpar->codec_type == AVMEDIA_TYPE_ATTACHMENT) {
            decoder->attachment_streams[attachment_idx++] = i;
        }
    }

    if (decoder->video_stream_idx == -1 && decoder->audio_stream_idx == -1) {
        return -1;
    }

    fprintf(stderr, "DEBUG: Found %d video, %d audio, %d subtitle streams\n",
             decoder->num_video_streams, decoder->num_audio_streams, decoder->num_subtitle_streams);

    // Don't initialize subtitle decoder by default - only when explicitly enabled
    // This prevents any subtitle-related overhead until actually needed

    return 0;
}

EMSCRIPTEN_KEEPALIVE
void decoder_destroy(AVDecoder *decoder) {
    if (!decoder) return;

    if (decoder->sws_ctx) sws_freeContext(decoder->sws_ctx);
    if (decoder->swr_ctx) swr_free(&decoder->swr_ctx);
    if (decoder->packet) av_packet_free(&decoder->packet);
    if (decoder->frame) av_frame_free(&decoder->frame);
    if (decoder->video_codec_ctx) avcodec_free_context(&decoder->video_codec_ctx);
    if (decoder->audio_codec_ctx) avcodec_free_context(&decoder->audio_codec_ctx);
    if (decoder->subtitle_codec_ctx) avcodec_free_context(&decoder->subtitle_codec_ctx);
    if (decoder->format_ctx) {
        if (decoder->format_ctx->pb) {
            av_free(decoder->format_ctx->pb->buffer);
            avio_context_free(&decoder->format_ctx->pb);
        }
        avformat_close_input(&decoder->format_ctx);
    }
    if (decoder->rgb_buffer) free(decoder->rgb_buffer);
    if (decoder->audio_buffer) free(decoder->audio_buffer);

    if (decoder->subtitle_filter_graph) {
        avfilter_graph_free(&decoder->subtitle_filter_graph);
    }
    if (decoder->subtitle_file_path) {
        remove(decoder->subtitle_file_path);
        free(decoder->subtitle_file_path);
    }
    if (decoder->video_streams) free(decoder->video_streams);
    if (decoder->audio_streams) free(decoder->audio_streams);
    if (decoder->subtitle_streams) free(decoder->subtitle_streams);
    if (decoder->attachment_streams) free(decoder->attachment_streams);

    decoder_cleanup_buffer_pool(decoder);

    free(decoder);
}

EMSCRIPTEN_KEEPALIVE
int decoder_seek(AVDecoder *decoder, double time_seconds) {
    if (!decoder || !decoder->format_ctx) return -1;

    int64_t seek_target = (int64_t)(time_seconds * AV_TIME_BASE);

    int ret = av_seek_frame(decoder->format_ctx, -1, seek_target, AVSEEK_FLAG_BACKWARD);

    if (ret >= 0) {
        decoder->current_position = time_seconds;

        if (decoder->video_codec_ctx) {
            avcodec_flush_buffers(decoder->video_codec_ctx);
        }
        if (decoder->audio_codec_ctx) {
            avcodec_flush_buffers(decoder->audio_codec_ctx);
        }

        if (decoder->audio_buffer) {
            decoder->audio_buffer_pos = 0;
        }

        // Reset frame timing for better sync after seek
        decoder->frame_count = (int)(time_seconds * 25.0); // Estimate frame count
        decoder->frame_timestamp = time_seconds;
        decoder->error_count = 0;
    }

    return ret;
}

EMSCRIPTEN_KEEPALIVE
double decoder_get_duration(AVDecoder *decoder) {
    if (!decoder || !decoder->format_ctx) return 0.0;

    if (decoder->format_ctx->duration != AV_NOPTS_VALUE) {
        return (double)decoder->format_ctx->duration / AV_TIME_BASE;
    }

    return 0.0; // Unknown duration
}

EMSCRIPTEN_KEEPALIVE
const char* decoder_get_codec_name(AVDecoder *decoder) {
    if (!decoder || !decoder->video_codec) return "unknown";
    return decoder->video_codec->name;
}

EMSCRIPTEN_KEEPALIVE
const char* decoder_get_version() {
    static char version[256];
    snprintf(version, sizeof(version), "libavcodec %d.%d.%d",
             LIBAVCODEC_VERSION_MAJOR,
             LIBAVCODEC_VERSION_MINOR,
             LIBAVCODEC_VERSION_MICRO);
    return version;
}

EMSCRIPTEN_KEEPALIVE
int decoder_set_thread_count(AVDecoder *decoder, int count) {
    if (!decoder) return -1;

    // Set thread count for video codec if available
    if (decoder->video_codec_ctx) {
        decoder->video_codec_ctx->thread_count = count;

        // If count is 1, disable threading. Otherwise enable frame threading
        if (count == 1) {
            decoder->video_codec_ctx->thread_type = 0;
        } else {
            decoder->video_codec_ctx->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
        }
    }

    // Set thread count for audio codec if available
    if (decoder->audio_codec_ctx) {
        decoder->audio_codec_ctx->thread_count = count;

        if (count == 1) {
            decoder->audio_codec_ctx->thread_type = 0;
        } else {
            decoder->audio_codec_ctx->thread_type = FF_THREAD_FRAME;
        }
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_thread_count(AVDecoder *decoder) {
    if (!decoder) return 0;

    // Return video codec thread count if available, otherwise audio
    if (decoder->video_codec_ctx) {
        return decoder->video_codec_ctx->thread_count;
    }

    if (decoder->audio_codec_ctx) {
        return decoder->audio_codec_ctx->thread_count;
    }

    return 0;
}