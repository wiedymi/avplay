#ifndef DECODER_SYNC_H
#define DECODER_SYNC_H

#include <libavutil/rational.h>
#include <sys/time.h>
#include <stdint.h>

// Forward declarations
struct AVDecoder;  // Defined in decoder.h

// Sync states
typedef enum {
    SYNC_STATE_IDLE,
    SYNC_STATE_PLAYING,
    SYNC_STATE_SEEKING,
    SYNC_STATE_BUFFERING
} SyncState;

// Clock types for synchronization
typedef enum {
    SYNC_CLOCK_AUDIO,    // Audio master (preferred)
    SYNC_CLOCK_VIDEO,    // Video master
    SYNC_CLOCK_EXTERNAL  // External clock
} SyncClockType;

// Ring buffer for continuous audio playback
typedef struct {
    uint8_t *data;
    int size;
    int capacity;
    int read_pos;
    int write_pos;
    int samples_per_frame;
    int channels;
    int sample_rate;
    double pts_start;      // PTS of first sample in buffer
    double pts_per_sample; // Time increment per sample
} AudioRingBuffer;

// Master clock for synchronization
typedef struct {
    SyncClockType type;
    double pts;           // Current presentation timestamp
    double last_updated;  // When clock was last updated (system time)
    double speed;         // Playback speed (1.0 = normal)
    int paused;           // Clock is paused
} MasterClock;

// Sync statistics for monitoring
typedef struct {
    double video_drift;    // Video drift from master clock (seconds)
    double audio_drift;    // Audio drift from master clock (seconds)
    int frames_dropped;    // Frames dropped for sync
    int frames_duplicated; // Frames duplicated for sync
    double last_video_pts; // Last video PTS processed
    double last_audio_pts; // Last audio PTS processed
    int sync_corrections;  // Number of sync corrections made
} SyncStats;

// Main synchronization context
typedef struct {
    SyncState state;
    MasterClock master_clock;
    SyncStats stats;

    // Ring buffer for audio continuity
    AudioRingBuffer *audio_ring;

    // Sync parameters
    double max_video_drift;      // Max allowed video drift (0.04s = ~1 frame at 25fps)
    double max_audio_drift;      // Max allowed audio drift (0.02s)
    double frame_drop_threshold; // When to drop frames (-0.1s)
    double frame_dup_threshold;  // When to duplicate frames (0.1s)

    // Buffer management
    int min_audio_buffer_ms;     // Minimum audio buffer (100ms)
    int max_audio_buffer_ms;     // Maximum audio buffer (2000ms)
    int target_video_frames;     // Target video frame buffer (25 frames)

    // Performance tracking
    double last_sync_time;       // Last sync adjustment time
    int consecutive_drops;       // Consecutive dropped frames
    int consecutive_dups;        // Consecutive duplicated frames
} SyncContext;

// Synchronization API functions

/**
 * Create and initialize sync context
 */
SyncContext* sync_context_create(void);

/**
 * Destroy sync context and free resources
 */
void sync_context_destroy(SyncContext *ctx);

/**
 * Initialize synchronization for playback start
 */
int sync_init_playback(SyncContext *ctx, int channels, int sample_rate);

/**
 * Update master clock with new PTS
 */
void sync_update_master_clock(SyncContext *ctx, double pts, SyncClockType source);

/**
 * Get current master clock time
 */
double sync_get_master_clock(SyncContext *ctx);

/**
 * Check if video frame should be presented now
 * Returns: 1 = present now, 0 = wait, -1 = drop frame
 */
int sync_check_video_timing(SyncContext *ctx, double video_pts);

/**
 * Add audio samples to ring buffer with PTS
 */
int sync_add_audio_samples(SyncContext *ctx, const uint8_t *samples, int size, double pts);

/**
 * Get audio samples from ring buffer for playback
 */
int sync_get_audio_samples(SyncContext *ctx, uint8_t *output, int requested_size, double *pts_out);

/**
 * Handle seek operation - reset sync state
 */
void sync_handle_seek(SyncContext *ctx, double target_pts);

/**
 * Pause/resume synchronization
 */
void sync_set_paused(SyncContext *ctx, int paused);

/**
 * Set playback speed
 */
void sync_set_speed(SyncContext *ctx, double speed);

/**
 * Get sync statistics for monitoring
 */
const SyncStats* sync_get_stats(SyncContext *ctx);

/**
 * Reset sync statistics
 */
void sync_reset_stats(SyncContext *ctx);

/**
 * Check if audio buffer needs more data
 */
int sync_audio_needs_data(SyncContext *ctx);

/**
 * Get audio buffer health (0-100%)
 */
int sync_get_audio_buffer_health(SyncContext *ctx);

// Ring buffer utilities
AudioRingBuffer* audio_ring_buffer_create(int capacity, int channels, int sample_rate);
void audio_ring_buffer_destroy(AudioRingBuffer *ring);
int audio_ring_buffer_write(AudioRingBuffer *ring, const uint8_t *data, int size, double pts);
int audio_ring_buffer_read(AudioRingBuffer *ring, uint8_t *output, int size, double *pts_out);
int audio_ring_buffer_available(AudioRingBuffer *ring);
int audio_ring_buffer_free_space(AudioRingBuffer *ring);
void audio_ring_buffer_reset(AudioRingBuffer *ring);

// Timing utilities
double get_system_time(void);
double pts_to_seconds(int64_t pts, AVRational time_base);
int64_t seconds_to_pts(double seconds, AVRational time_base);

#endif // DECODER_SYNC_H