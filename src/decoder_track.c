#include "decoder.h"


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
int decoder_extract_track(AVDecoder *decoder, int track_type, int track_index) {
    if (!decoder || !decoder->format_ctx) {
        return -1;
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

    // Initialize track extraction buffer
    if (track_extract_buffer) {
        free(track_extract_buffer);
        track_extract_buffer = NULL;
    }
    track_extract_buffer_size = 0;
    track_extract_buffer_capacity = 1024 * 1024; // 1MB initial

    track_extract_buffer = (uint8_t*)malloc(track_extract_buffer_capacity);
    if (!track_extract_buffer) {
        return -1;
    }

    // Determine output format based on track type and codec
    const char *format_name = NULL;
    const AVOutputFormat *output_format = NULL;

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
                format_name = "mov_text";
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
                format_name = "aac";
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
            free(track_extract_buffer);
            track_extract_buffer = NULL;
            return -1;
        }
    }

    // Allocate AVIO buffer
    uint8_t *avio_buffer = (uint8_t*)av_malloc(32768);
    if (!avio_buffer) {
        free(track_extract_buffer);
        track_extract_buffer = NULL;
        return -1;
    }

    AVIOContext *avio_ctx = avio_alloc_context(avio_buffer, 32768, 1, NULL, NULL, write_to_buffer, seek_in_buffer);
    if (avio_ctx) {
        avio_ctx->seekable = AVIO_SEEKABLE_NORMAL;
    }
    if (!avio_ctx) {
        av_free(avio_buffer);
        free(track_extract_buffer);
        track_extract_buffer = NULL;
        return -1;
    }

    AVFormatContext *output_ctx = NULL;
    int ret = avformat_alloc_output_context2(&output_ctx, output_format, NULL, NULL);
    if (ret < 0 || !output_ctx) {
        av_free(avio_ctx->buffer);
        av_free(avio_ctx);
        free(track_extract_buffer);
        track_extract_buffer = NULL;
        return -1;
    }

    output_ctx->pb = avio_ctx;
    output_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

    AVStream *output_stream = avformat_new_stream(output_ctx, NULL);
    if (!output_stream) {
        ret = AVERROR(ENOMEM);
        goto cleanup;
    }

    ret = avcodec_parameters_copy(output_stream->codecpar, input_stream->codecpar);
    if (ret < 0) {
        goto cleanup;
    }

    output_stream->codecpar->codec_tag = 0;

    output_stream->time_base = input_stream->time_base;

    if (output_ctx->oformat->flags & AVFMT_GLOBALHEADER) {
        output_stream->codecpar->codec_tag = 0;
    }

    ret = avformat_write_header(output_ctx, NULL);
    if (ret < 0) {
        goto cleanup;
    }

    decoder->input_buffer_pos = 0;
    av_seek_frame(decoder->format_ctx, -1, 0, AVSEEK_FLAG_BACKWARD);

    AVPacket *pkt = av_packet_alloc();
    if (!pkt) {
        ret = AVERROR(ENOMEM);
        goto cleanup;
    }

    int packet_count = 0;
    while (av_read_frame(decoder->format_ctx, pkt) >= 0) {
        if (pkt->stream_index == stream_idx) {
            pkt->stream_index = 0;

            av_packet_rescale_ts(pkt, input_stream->time_base, output_stream->time_base);

            pkt->pos = -1;

            ret = av_interleaved_write_frame(output_ctx, pkt);
            if (ret < 0) {
            }
            packet_count++;
        }
        av_packet_unref(pkt);
    }


    ret = av_write_trailer(output_ctx);
    if (ret < 0) {
    }

    av_packet_free(&pkt);

cleanup:
    if (output_ctx) {
        if (!(output_ctx->oformat->flags & AVFMT_NOFILE) && output_ctx->pb) {
        }
        avformat_free_context(output_ctx);
    }
    if (avio_ctx) {
        av_free(avio_ctx->buffer);
        av_free(avio_ctx);
    }

    decoder->input_buffer_pos = 0;
    av_seek_frame(decoder->format_ctx, -1, 0, AVSEEK_FLAG_BACKWARD);

    if (ret < 0 && track_extract_buffer_size == 0) {
        free(track_extract_buffer);
        track_extract_buffer = NULL;
        return -1;
    }

    return track_extract_buffer_size;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* decoder_get_extracted_track_data() {
    return track_extract_buffer;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_extracted_track_size() {
    return track_extract_buffer_size;
}

EMSCRIPTEN_KEEPALIVE
void decoder_free_extracted_track() {
    if (track_extract_buffer) {
        free(track_extract_buffer);
        track_extract_buffer = NULL;
        track_extract_buffer_size = 0;
        track_extract_buffer_capacity = 0;
    }
}

EMSCRIPTEN_KEEPALIVE
void decoder_cleanup_global_buffers() {
    decoder_free_extracted_track();
}