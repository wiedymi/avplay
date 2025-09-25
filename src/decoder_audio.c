#include "decoder.h"
#include "decoder_sync.h"

EMSCRIPTEN_KEEPALIVE
int decoder_has_audio(AVDecoder *decoder) {
    return decoder && decoder->audio_stream_idx >= 0 ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_audio_sample_rate(AVDecoder *decoder) {
    return decoder ? decoder->audio_sample_rate : 0;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_audio_channels(AVDecoder *decoder) {
    return decoder ? decoder->audio_channels : 0;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_audio_buffer_size(AVDecoder *decoder) {
    // Keep the original simple implementation
    return decoder ? decoder->audio_buffer_pos : 0;
}

EMSCRIPTEN_KEEPALIVE
float* decoder_get_audio_buffer(AVDecoder *decoder) {
    // Keep the original simple implementation - sync system is for timing only
    if (!decoder || decoder->audio_buffer_pos == 0) return NULL;
    return (float*)decoder->audio_buffer;
}

EMSCRIPTEN_KEEPALIVE
void decoder_clear_audio_buffer(AVDecoder *decoder) {
    if (!decoder) return;

    // Clear sync system audio buffer - use API instead of direct access
    // Note: There's no direct reset API, but clearing old buffer will trigger refill

    // Clear old buffer
    decoder->audio_buffer_pos = 0;
}

EMSCRIPTEN_KEEPALIVE
const char* decoder_get_audio_codec_name(AVDecoder *decoder) {
    if (!decoder || !decoder->audio_codec) return "unknown";
    return decoder->audio_codec->name;
}

EMSCRIPTEN_KEEPALIVE
int decoder_get_audio_track_count(AVDecoder *decoder) {
    return decoder ? decoder->num_audio_streams : 0;
}

EMSCRIPTEN_KEEPALIVE
const char* decoder_get_audio_track_info(AVDecoder *decoder, int track_index) {
    static char info[512];
    if (!decoder || track_index < 0 || track_index >= decoder->num_audio_streams) {
        return "Invalid track";
    }

    int stream_idx = decoder->audio_streams[track_index];
    AVStream *stream = decoder->format_ctx->streams[stream_idx];
    AVCodecParameters *codecpar = stream->codecpar;

    const AVCodec *codec = avcodec_find_decoder(codecpar->codec_id);
    const char *codec_name = codec ? codec->name : "unknown";

    AVDictionaryEntry *lang = av_dict_get(stream->metadata, "language", NULL, 0);
    AVDictionaryEntry *title = av_dict_get(stream->metadata, "title", NULL, 0);
    const char *language = lang ? lang->value : "unknown";
    const char *track_title = title ? title->value : "";

    char layout_str[64];
    av_channel_layout_describe(&codecpar->ch_layout, layout_str, sizeof(layout_str));

    if (strlen(track_title) > 0) {
        snprintf(info, sizeof(info), "Track %d: %s, %d Hz, %s [%s] \"%s\"",
                 track_index + 1, codec_name, codecpar->sample_rate, layout_str, language, track_title);
    } else {
        snprintf(info, sizeof(info), "Track %d: %s, %d Hz, %s [%s]",
                 track_index + 1, codec_name, codecpar->sample_rate, layout_str, language);
    }

    return info;
}

EMSCRIPTEN_KEEPALIVE
int decoder_switch_audio_track(AVDecoder *decoder, int track_index) {
    if (!decoder || track_index < 0 || track_index >= decoder->num_audio_streams) {
        return -1;
    }

    if (decoder->audio_codec_ctx) {
        avcodec_free_context(&decoder->audio_codec_ctx);
        decoder->audio_codec_ctx = NULL;
    }

    if (decoder->swr_ctx) {
        swr_free(&decoder->swr_ctx);
        decoder->swr_ctx = NULL;
    }

    int stream_idx = decoder->audio_streams[track_index];
    AVStream *stream = decoder->format_ctx->streams[stream_idx];
    AVCodecParameters *codecpar = stream->codecpar;

    decoder->audio_codec = avcodec_find_decoder(codecpar->codec_id);
    if (!decoder->audio_codec) {
        return -1;
    }

    decoder->audio_codec_ctx = avcodec_alloc_context3(decoder->audio_codec);
    if (!decoder->audio_codec_ctx) {
        return -1;
    }

    if (avcodec_parameters_to_context(decoder->audio_codec_ctx, codecpar) < 0) {
        avcodec_free_context(&decoder->audio_codec_ctx);
        return -1;
    }

    if (avcodec_open2(decoder->audio_codec_ctx, decoder->audio_codec, NULL) < 0) {
        avcodec_free_context(&decoder->audio_codec_ctx);
        return -1;
    }

    decoder->audio_stream_idx = stream_idx;
    decoder->selected_audio_stream = track_index;

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

        decoder->audio_sample_rate = decoder->audio_codec_ctx->sample_rate;
        decoder->audio_channels = 2;

        // Reinitialize sync system with new audio parameters
        if (decoder->sync_ctx) {
            sync_init_playback(decoder->sync_ctx, 2, decoder->audio_sample_rate);
        }
    }

    if (decoder->current_position > 0.0) {
        decoder_seek(decoder, decoder->current_position);
    }

    return 0;
}