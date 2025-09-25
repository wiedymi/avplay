#include "decoder.h"
#include "decoder_sync.h"

extern int init_subtitle_decoder(AVDecoder *decoder);
extern int decoder_render_subtitles_filter(AVDecoder *decoder, AVFrame *video_frame);


EMSCRIPTEN_KEEPALIVE
int decoder_decode_frame(AVDecoder *decoder) {
    if (!decoder || !decoder->format_ctx) return -1;

    int ret;
    int video_decoded = 0;

    while (1) {
        ret = av_read_frame(decoder->format_ctx, decoder->packet);
        if (ret < 0) {
            if (ret == AVERROR_EOF) {
                if (decoder->video_stream_idx >= 0 && decoder->video_codec_ctx) {
                    avcodec_send_packet(decoder->video_codec_ctx, NULL);
                    ret = avcodec_receive_frame(decoder->video_codec_ctx, decoder->frame);
                    if (ret == 0) {
                        video_decoded = 1;
                    }
                }

                decoder->input_buffer_pos = 0;
                av_seek_frame(decoder->format_ctx, decoder->video_stream_idx, 0, AVSEEK_FLAG_BACKWARD);
                if (decoder->video_codec_ctx) {
                    avcodec_flush_buffers(decoder->video_codec_ctx);
                }
                if (decoder->audio_codec_ctx) {
                    avcodec_flush_buffers(decoder->audio_codec_ctx);
                }
                continue;
            }

            decoder->error_count++;
            if (decoder->error_count > decoder->max_errors) {
            }
            return ret;
        }

        if (decoder->packet->stream_index == decoder->video_stream_idx) {
            ret = avcodec_send_packet(decoder->video_codec_ctx, decoder->packet);
            av_packet_unref(decoder->packet);

            if (ret >= 0) {
                ret = avcodec_receive_frame(decoder->video_codec_ctx, decoder->frame);
                if (ret == 0) {
                    // Update current position and frame timestamp using proper PTS
                    AVStream *video_stream = decoder->format_ctx->streams[decoder->video_stream_idx];
                    if (decoder->frame->pts != AV_NOPTS_VALUE) {
                        if (video_stream->time_base.den > 0) {
                            decoder->frame_timestamp = pts_to_seconds(decoder->frame->pts, video_stream->time_base);
                            decoder->current_position = decoder->frame_timestamp;
                            decoder->last_video_pts = decoder->frame_timestamp;
                        }
                    } else {
                        // Estimate timestamp based on frame rate if PTS is not available
                        if (decoder->frame_count > 0 && video_stream->avg_frame_rate.den > 0) {
                            double frame_duration = (double)video_stream->avg_frame_rate.den / video_stream->avg_frame_rate.num;
                            decoder->frame_timestamp = decoder->frame_count * frame_duration;
                            decoder->last_video_pts = decoder->frame_timestamp;
                        }
                    }

                    // Check with sync system if frame should be presented
                    int sync_decision = 1; // Default: present frame
                    if (decoder->sync_ctx && decoder->frame_timestamp > 0) {
                        sync_decision = sync_check_video_timing(decoder->sync_ctx, decoder->frame_timestamp);
                        sync_update_master_clock(decoder->sync_ctx, decoder->frame_timestamp, SYNC_CLOCK_VIDEO);
                    }

                    decoder->frame_count++;

                    // Handle sync decision: -1=drop, 0=wait, 1=present
                    if (sync_decision == -1) {
                        // Drop this frame for sync - continue to next packet
                        continue;
                    }

                    // Subtitle rendering will be done later in decoder_get_frame_rgb() to avoid double processing

                    video_decoded = 1;
                } else if (ret == AVERROR_INVALIDDATA) {
                    decoder->error_count++;
                    if (decoder->error_count > decoder->max_errors) {
                        return -2;
                    }
                }
            }
        }
        else if (decoder->packet->stream_index == decoder->audio_stream_idx) {
            ret = avcodec_send_packet(decoder->audio_codec_ctx, decoder->packet);
            av_packet_unref(decoder->packet);

            if (ret >= 0) {
                AVFrame *audio_frame = av_frame_alloc();
                ret = avcodec_receive_frame(decoder->audio_codec_ctx, audio_frame);

                if (ret == 0 && decoder->swr_ctx) {
                    // Calculate audio PTS
                    double audio_pts = 0.0;
                    AVStream *audio_stream = decoder->format_ctx->streams[decoder->audio_stream_idx];
                    if (audio_frame->pts != AV_NOPTS_VALUE && audio_stream->time_base.den > 0) {
                        audio_pts = pts_to_seconds(audio_frame->pts, audio_stream->time_base);
                        decoder->last_audio_pts = audio_pts;
                    } else {
                        // Estimate PTS if not available
                        audio_pts = decoder->last_audio_pts + (double)audio_frame->nb_samples / decoder->audio_sample_rate;
                        decoder->last_audio_pts = audio_pts;
                    }

                    uint8_t *output_buffer[2];
                    int dst_linesize;
                    int dst_nb_samples = av_rescale_rnd(audio_frame->nb_samples,
                                                        decoder->audio_sample_rate,
                                                        decoder->audio_sample_rate,
                                                        AV_ROUND_UP);

                    av_samples_alloc(output_buffer, &dst_linesize, 2,
                                    dst_nb_samples, AV_SAMPLE_FMT_FLT, 0);

                    int converted = swr_convert(decoder->swr_ctx,
                                               output_buffer, dst_nb_samples,
                                               (const uint8_t **)audio_frame->data, audio_frame->nb_samples);

                    if (converted > 0) {
                        int bytes_to_copy = converted * 2 * sizeof(float);

                        // ALWAYS copy to the regular audio buffer for playback
                        if (decoder->audio_buffer_pos + bytes_to_copy <= decoder->audio_buffer_size) {
                            memcpy(decoder->audio_buffer + decoder->audio_buffer_pos,
                                  output_buffer[0], bytes_to_copy);
                            decoder->audio_buffer_pos += bytes_to_copy;
                            decoder->audio_samples_per_frame = converted;
                        }

                        // ALSO use sync system for timing if available
                        if (decoder->sync_ctx) {
                            sync_add_audio_samples(decoder->sync_ctx, output_buffer[0], bytes_to_copy, audio_pts);
                            sync_update_master_clock(decoder->sync_ctx, audio_pts, SYNC_CLOCK_AUDIO);
                        }
                    }

                    av_freep(&output_buffer[0]);
                }
                av_frame_free(&audio_frame);
            }
        }
        else if (decoder->packet->stream_index == decoder->subtitle_stream_idx) {
            av_packet_unref(decoder->packet);
        }
        else {
            av_packet_unref(decoder->packet);
        }

        // Return success only after we've processed a video frame
        // This allows audio and subtitle packets to be processed in the same call
        if (video_decoded) {
            return 0;
        }
    }
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_width(AVDecoder *decoder) {
    return decoder && decoder->frame ? decoder->frame->width : 0;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_height(AVDecoder *decoder) {
    return decoder && decoder->frame ? decoder->frame->height : 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* decoder_get_frame_rgb(AVDecoder *decoder) {
    if (!decoder || !decoder->frame || decoder->frame->width == 0) {
        return NULL;
    }

    int width = decoder->frame->width;
    int height = decoder->frame->height;
    int rgb_size = width * height * 4; // RGBA

    if (!decoder->rgb_buffer || decoder->rgb_buffer_size < rgb_size) {
        uint8_t *new_buffer = (uint8_t*)realloc(decoder->rgb_buffer, rgb_size);
        if (!new_buffer) {
            return NULL;
        }
        decoder->rgb_buffer = new_buffer;
        decoder->rgb_buffer_size = rgb_size;
    }

    // Clear the buffer to prevent visual artifacts from previous frames
    memset(decoder->rgb_buffer, 0, rgb_size);

    if (!decoder->sws_ctx) {
        decoder->sws_ctx = sws_getContext(
            width, height, decoder->frame->format,
            width, height, AV_PIX_FMT_RGBA,
            SWS_BILINEAR, NULL, NULL, NULL
        );
    }

    uint8_t *dst_data[4] = { decoder->rgb_buffer, NULL, NULL, NULL };
    int dst_linesize[4] = { width * 4, 0, 0, 0 };

    // Apply subtitle rendering if enabled and filter is ready
    if (decoder->subtitle_enabled && decoder->use_filter_rendering && decoder->subtitle_filter_graph) {
        // Only render subtitles if we have valid timing information
        if (decoder->frame->pts != AV_NOPTS_VALUE || decoder->frame_timestamp > 0) {
            int filter_result = decoder_render_subtitles_filter(decoder, decoder->frame);
            // Continue processing even if subtitle rendering fails to avoid breaking video
            if (filter_result < 0) {
                // Log error but don't fail the entire frame
                fprintf(stderr, "Warning: Subtitle rendering failed\n");
            }
        }
    }

    int result = sws_scale(decoder->sws_ctx,
                          (const uint8_t * const *)decoder->frame->data,
                          decoder->frame->linesize,
                          0, height,
                          dst_data, dst_linesize);

    if (result != height) {
        // Scale failed, clear buffer to prevent artifacts
        memset(decoder->rgb_buffer, 0, rgb_size);
        return NULL;
    }


    return decoder->rgb_buffer;
}


EMSCRIPTEN_KEEPALIVE
int decoder_get_video_track_count(AVDecoder *decoder) {
    return decoder ? decoder->num_video_streams : 0;
}


EMSCRIPTEN_KEEPALIVE
const char* decoder_get_video_track_info(AVDecoder *decoder, int track_index) {
    static char info[512];
    if (!decoder || track_index < 0 || track_index >= decoder->num_video_streams) {
        return "Invalid track";
    }

    int stream_idx = decoder->video_streams[track_index];
    AVStream *stream = decoder->format_ctx->streams[stream_idx];
    AVCodecParameters *codecpar = stream->codecpar;

    const AVCodec *codec = avcodec_find_decoder(codecpar->codec_id);
    const char *codec_name = codec ? codec->name : "unknown";

    AVDictionaryEntry *lang = av_dict_get(stream->metadata, "language", NULL, 0);
    AVDictionaryEntry *title = av_dict_get(stream->metadata, "title", NULL, 0);
    const char *language = lang ? lang->value : "unknown";
    const char *track_title = title ? title->value : "";

    if (strlen(track_title) > 0) {
        snprintf(info, sizeof(info), "Track %d: %s, %dx%d, %.2f fps [%s] \"%s\"",
                 track_index + 1, codec_name, codecpar->width, codecpar->height,
                 av_q2d(stream->avg_frame_rate), language, track_title);
    } else {
        snprintf(info, sizeof(info), "Track %d: %s, %dx%d, %.2f fps [%s]",
                 track_index + 1, codec_name, codecpar->width, codecpar->height,
                 av_q2d(stream->avg_frame_rate), language);
    }

    return info;
}


EMSCRIPTEN_KEEPALIVE
double decoder_get_frame_timestamp(AVDecoder *decoder) {
    return decoder ? decoder->frame_timestamp : 0.0;
}

EMSCRIPTEN_KEEPALIVE
int decoder_switch_video_track(AVDecoder *decoder, int track_index) {
    if (!decoder || track_index < 0 || track_index >= decoder->num_video_streams) {
        return -1;
    }

    if (decoder->video_codec_ctx) {
        avcodec_free_context(&decoder->video_codec_ctx);
        decoder->video_codec_ctx = NULL;
    }
    if (decoder->sws_ctx) {
        sws_freeContext(decoder->sws_ctx);
        decoder->sws_ctx = NULL;
    }

    int stream_idx = decoder->video_streams[track_index];
    AVStream *stream = decoder->format_ctx->streams[stream_idx];

    decoder->video_codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!decoder->video_codec) {
        return -1;
    }

    decoder->video_codec_ctx = avcodec_alloc_context3(decoder->video_codec);
    if (!decoder->video_codec_ctx) {
        return -1;
    }

    if (avcodec_parameters_to_context(decoder->video_codec_ctx, stream->codecpar) < 0) {
        avcodec_free_context(&decoder->video_codec_ctx);
        return -1;
    }

    AVDictionary *opts = NULL;
    av_dict_set(&opts, "threads", "1", 0);

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
        return -1;
    }
    av_dict_free(&opts);

    decoder->video_stream_idx = stream_idx;
    decoder->selected_video_stream = track_index;
    decoder->error_count = 0;

    if (decoder->current_position > 0.0) {
        decoder_seek(decoder, decoder->current_position);
    }

    return 0;
}