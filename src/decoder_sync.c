#include "decoder.h"
#include "decoder_sync.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>

// System time utilities
double get_system_time(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec + tv.tv_usec / 1000000.0;
}

double pts_to_seconds(int64_t pts, AVRational time_base) {
    if (pts == AV_NOPTS_VALUE) return 0.0;
    return pts * av_q2d(time_base);
}

int64_t seconds_to_pts(double seconds, AVRational time_base) {
    return (int64_t)(seconds / av_q2d(time_base));
}

// Ring buffer implementation
AudioRingBuffer* audio_ring_buffer_create(int capacity, int channels, int sample_rate) {
    AudioRingBuffer *ring = (AudioRingBuffer*)calloc(1, sizeof(AudioRingBuffer));
    if (!ring) return NULL;

    ring->capacity = capacity;
    ring->data = (uint8_t*)malloc(capacity);
    if (!ring->data) {
        free(ring);
        return NULL;
    }

    ring->channels = channels;
    ring->sample_rate = sample_rate;
    ring->samples_per_frame = sample_rate / 25; // Assume 25fps for frame calculations
    ring->pts_per_sample = 1.0 / sample_rate;
    audio_ring_buffer_reset(ring);

    return ring;
}

void audio_ring_buffer_destroy(AudioRingBuffer *ring) {
    if (!ring) return;
    if (ring->data) free(ring->data);
    free(ring);
}

void audio_ring_buffer_reset(AudioRingBuffer *ring) {
    if (!ring) return;
    ring->read_pos = 0;
    ring->write_pos = 0;
    ring->size = 0;
    ring->pts_start = 0.0;
}

int audio_ring_buffer_available(AudioRingBuffer *ring) {
    return ring ? ring->size : 0;
}

int audio_ring_buffer_free_space(AudioRingBuffer *ring) {
    return ring ? (ring->capacity - ring->size) : 0;
}

int audio_ring_buffer_write(AudioRingBuffer *ring, const uint8_t *data, int size, double pts) {
    if (!ring || !data || size <= 0) return 0;

    int free_space = audio_ring_buffer_free_space(ring);
    if (size > free_space) {
        // Buffer overflow - advance read position to make room
        int overflow = size - free_space;
        ring->read_pos = (ring->read_pos + overflow) % ring->capacity;
        ring->size -= overflow;
        ring->pts_start += overflow * ring->pts_per_sample / ring->channels / sizeof(float);
    }

    // Set PTS if this is the first data
    if (ring->size == 0) {
        ring->pts_start = pts;
    }

    // Write data in two parts if it wraps around
    int bytes_to_end = ring->capacity - ring->write_pos;
    if (size <= bytes_to_end) {
        memcpy(ring->data + ring->write_pos, data, size);
    } else {
        memcpy(ring->data + ring->write_pos, data, bytes_to_end);
        memcpy(ring->data, data + bytes_to_end, size - bytes_to_end);
    }

    ring->write_pos = (ring->write_pos + size) % ring->capacity;
    ring->size += size;

    return size;
}

int audio_ring_buffer_read(AudioRingBuffer *ring, uint8_t *output, int size, double *pts_out) {
    if (!ring || !output || size <= 0) return 0;

    int available = audio_ring_buffer_available(ring);
    if (size > available) size = available;
    if (size == 0) return 0;

    // Calculate PTS for this read
    if (pts_out) {
        *pts_out = ring->pts_start;
    }

    // Read data in two parts if it wraps around
    int bytes_to_end = ring->capacity - ring->read_pos;
    if (size <= bytes_to_end) {
        memcpy(output, ring->data + ring->read_pos, size);
    } else {
        memcpy(output, ring->data + ring->read_pos, bytes_to_end);
        memcpy(output + bytes_to_end, ring->data, size - bytes_to_end);
    }

    ring->read_pos = (ring->read_pos + size) % ring->capacity;
    ring->size -= size;

    // Update PTS start for next read
    ring->pts_start += size * ring->pts_per_sample / ring->channels / sizeof(float);

    return size;
}

// Sync context implementation
SyncContext* sync_context_create(void) {
    SyncContext *ctx = (SyncContext*)calloc(1, sizeof(SyncContext));
    if (!ctx) return NULL;

    // Initialize default parameters
    ctx->state = SYNC_STATE_IDLE;
    ctx->master_clock.type = SYNC_CLOCK_AUDIO;
    ctx->master_clock.speed = 1.0;
    ctx->master_clock.paused = 1;

    // Sync thresholds
    ctx->max_video_drift = 0.04;      // ~1 frame at 25fps
    ctx->max_audio_drift = 0.02;      // 20ms
    ctx->frame_drop_threshold = -0.1; // Drop if 100ms behind
    ctx->frame_dup_threshold = 0.1;   // Duplicate if 100ms ahead

    // Buffer sizes
    ctx->min_audio_buffer_ms = 100;   // 100ms minimum
    ctx->max_audio_buffer_ms = 2000;  // 2 second maximum
    ctx->target_video_frames = 25;    // 1 second at 25fps

    sync_reset_stats(ctx);

    return ctx;
}

void sync_context_destroy(SyncContext *ctx) {
    if (!ctx) return;

    if (ctx->audio_ring) {
        audio_ring_buffer_destroy(ctx->audio_ring);
    }

    free(ctx);
}

int sync_init_playback(SyncContext *ctx, int channels, int sample_rate) {
    if (!ctx) return -1;

    // Create audio ring buffer based on provided parameters
    int audio_buffer_size = 0;

    // Default values if not provided
    if (channels <= 0) channels = 2;
    if (sample_rate <= 0) sample_rate = 48000;

    // Calculate buffer size for 2 seconds of audio
    audio_buffer_size = sample_rate * channels * sizeof(float) * 2;

    if (ctx->audio_ring) {
        audio_ring_buffer_destroy(ctx->audio_ring);
    }

    ctx->audio_ring = audio_ring_buffer_create(audio_buffer_size, channels, sample_rate);
    if (!ctx->audio_ring) return -1;

    // Reset sync state
    ctx->state = SYNC_STATE_BUFFERING;
    ctx->master_clock.pts = 0.0;
    ctx->master_clock.last_updated = get_system_time();
    ctx->master_clock.paused = 0;

    sync_reset_stats(ctx);

    return 0;
}

void sync_update_master_clock(SyncContext *ctx, double pts, SyncClockType source) {
    if (!ctx) return;

    double now = get_system_time();

    // Update master clock if this is the preferred source
    if (source == ctx->master_clock.type) {
        ctx->master_clock.pts = pts;
        ctx->master_clock.last_updated = now;
    }

    // Track drift for statistics
    double clock_time = sync_get_master_clock(ctx);
    if (source == SYNC_CLOCK_VIDEO) {
        ctx->stats.video_drift = pts - clock_time;
        ctx->stats.last_video_pts = pts;
    } else if (source == SYNC_CLOCK_AUDIO) {
        ctx->stats.audio_drift = pts - clock_time;
        ctx->stats.last_audio_pts = pts;
    }
}

double sync_get_master_clock(SyncContext *ctx) {
    if (!ctx || ctx->master_clock.paused) return ctx->master_clock.pts;

    double now = get_system_time();
    double elapsed = now - ctx->master_clock.last_updated;
    return ctx->master_clock.pts + elapsed * ctx->master_clock.speed;
}

int sync_check_video_timing(SyncContext *ctx, double video_pts) {
    if (!ctx) return 1; // Present immediately if no sync

    double master_time = sync_get_master_clock(ctx);
    double drift = video_pts - master_time;

    // Update drift stats
    ctx->stats.video_drift = drift;

    // Check if frame should be dropped (too far behind)
    if (drift < ctx->frame_drop_threshold) {
        ctx->stats.frames_dropped++;
        ctx->consecutive_drops++;
        if (ctx->consecutive_drops > 5) {
            // Too many consecutive drops - adjust clock
            sync_update_master_clock(ctx, video_pts, SYNC_CLOCK_VIDEO);
            ctx->consecutive_drops = 0;
        }
        return -1; // Drop frame
    }

    // Check if frame should be duplicated (too far ahead)
    if (drift > ctx->frame_dup_threshold) {
        ctx->stats.frames_duplicated++;
        ctx->consecutive_dups++;
        return 0; // Wait/duplicate
    }

    // Frame is in sync
    ctx->consecutive_drops = 0;
    ctx->consecutive_dups = 0;

    // Present if within acceptable drift
    if (fabs(drift) <= ctx->max_video_drift) {
        return 1; // Present now
    }

    return (drift < 0) ? 1 : 0; // Present if behind, wait if ahead
}

int sync_add_audio_samples(SyncContext *ctx, const uint8_t *samples, int size, double pts) {
    if (!ctx || !ctx->audio_ring || !samples) return -1;

    int written = audio_ring_buffer_write(ctx->audio_ring, samples, size, pts);

    // Update master clock with audio PTS
    sync_update_master_clock(ctx, pts, SYNC_CLOCK_AUDIO);

    return written;
}

int sync_get_audio_samples(SyncContext *ctx, uint8_t *output, int requested_size, double *pts_out) {
    if (!ctx || !ctx->audio_ring || !output) return 0;

    return audio_ring_buffer_read(ctx->audio_ring, output, requested_size, pts_out);
}

void sync_handle_seek(SyncContext *ctx, double target_pts) {
    if (!ctx) return;

    ctx->state = SYNC_STATE_SEEKING;
    ctx->master_clock.pts = target_pts;
    ctx->master_clock.last_updated = get_system_time();

    if (ctx->audio_ring) {
        audio_ring_buffer_reset(ctx->audio_ring);
    }

    sync_reset_stats(ctx);
    ctx->consecutive_drops = 0;
    ctx->consecutive_dups = 0;
}

void sync_set_paused(SyncContext *ctx, int paused) {
    if (!ctx) return;

    if (paused && !ctx->master_clock.paused) {
        // Pausing - save current time
        ctx->master_clock.pts = sync_get_master_clock(ctx);
    } else if (!paused && ctx->master_clock.paused) {
        // Resuming - update last_updated time
        ctx->master_clock.last_updated = get_system_time();
    }

    ctx->master_clock.paused = paused;
    ctx->state = paused ? SYNC_STATE_IDLE : SYNC_STATE_PLAYING;
}

void sync_set_speed(SyncContext *ctx, double speed) {
    if (!ctx) return;

    // Update current PTS before changing speed
    if (!ctx->master_clock.paused) {
        ctx->master_clock.pts = sync_get_master_clock(ctx);
        ctx->master_clock.last_updated = get_system_time();
    }

    ctx->master_clock.speed = speed;
}

const SyncStats* sync_get_stats(SyncContext *ctx) {
    return ctx ? &ctx->stats : NULL;
}

void sync_reset_stats(SyncContext *ctx) {
    if (!ctx) return;

    memset(&ctx->stats, 0, sizeof(SyncStats));
}

int sync_audio_needs_data(SyncContext *ctx) {
    if (!ctx || !ctx->audio_ring) return 1;

    int available_ms = (audio_ring_buffer_available(ctx->audio_ring) * 1000) /
                      (ctx->audio_ring->sample_rate * ctx->audio_ring->channels * sizeof(float));

    return available_ms < ctx->min_audio_buffer_ms;
}

int sync_get_audio_buffer_health(SyncContext *ctx) {
    if (!ctx || !ctx->audio_ring) return 0;

    int available = audio_ring_buffer_available(ctx->audio_ring);
    int total = ctx->audio_ring->capacity;

    return (available * 100) / total;
}