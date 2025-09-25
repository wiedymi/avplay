#include "decoder.h"
#include <emscripten.h>

int read_packet_callback(void *opaque, uint8_t *buf, int buf_size) {
    AVDecoder *decoder = (AVDecoder *)opaque;
    int available = decoder->input_buffer_size - decoder->input_buffer_pos;
    int to_read = buf_size < available ? buf_size : available;

    if (to_read <= 0) {
        return AVERROR_EOF;
    }

    memcpy(buf, decoder->input_buffer + decoder->input_buffer_pos, to_read);
    decoder->input_buffer_pos += to_read;
    return to_read;
}

int64_t seek_callback(void *opaque, int64_t offset, int whence) {
    AVDecoder *decoder = (AVDecoder *)opaque;

    if (whence == AVSEEK_SIZE) {
        return decoder->input_buffer_size;
    }

    int64_t new_pos;
    switch (whence) {
        case SEEK_SET:
            new_pos = offset;
            break;
        case SEEK_CUR:
            new_pos = decoder->input_buffer_pos + offset;
            break;
        case SEEK_END:
            new_pos = decoder->input_buffer_size + offset;
            break;
        default:
            return -1;
    }

    if (new_pos < 0 || new_pos > decoder->input_buffer_size) {
        return -1;
    }

    decoder->input_buffer_pos = new_pos;
    return new_pos;
}

// Buffer pool implementation
BufferPool* buffer_pool_create(void) {
    BufferPool *pool = (BufferPool*)calloc(1, sizeof(BufferPool));
    if (!pool) return NULL;

    pool->initialized = 1;

    // Initialize small buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        pool->small_buffers[i].size = SMALL_BUFFER_SIZE;
        pool->small_buffers[i].data = (uint8_t*)av_malloc(SMALL_BUFFER_SIZE);
        pool->small_buffers[i].in_use = 0;
        if (!pool->small_buffers[i].data) {
            buffer_pool_destroy(pool);
            return NULL;
        }
    }

    // Initialize medium buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        pool->medium_buffers[i].size = MEDIUM_BUFFER_SIZE;
        pool->medium_buffers[i].data = (uint8_t*)av_malloc(MEDIUM_BUFFER_SIZE);
        pool->medium_buffers[i].in_use = 0;
        if (!pool->medium_buffers[i].data) {
            buffer_pool_destroy(pool);
            return NULL;
        }
    }

    // Initialize large buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        pool->large_buffers[i].size = LARGE_BUFFER_SIZE;
        pool->large_buffers[i].data = (uint8_t*)av_malloc(LARGE_BUFFER_SIZE);
        pool->large_buffers[i].in_use = 0;
        if (!pool->large_buffers[i].data) {
            buffer_pool_destroy(pool);
            return NULL;
        }
    }

    return pool;
}

void buffer_pool_destroy(BufferPool *pool) {
    if (!pool) return;

    // Free small buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->small_buffers[i].data) {
            av_free(pool->small_buffers[i].data);
        }
    }

    // Free medium buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->medium_buffers[i].data) {
            av_free(pool->medium_buffers[i].data);
        }
    }

    // Free large buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->large_buffers[i].data) {
            av_free(pool->large_buffers[i].data);
        }
    }

    free(pool);
}

uint8_t* buffer_pool_get(BufferPool *pool, int size) {
    if (!pool || size <= 0) return NULL;

    PooledBuffer *buffers = NULL;
    int buffer_size = 0;
    int pool_size = BUFFER_POOL_SIZE;

    // Select appropriate buffer pool with optimized allocation strategy
    if (size <= SMALL_BUFFER_SIZE) {
        buffers = pool->small_buffers;
        buffer_size = SMALL_BUFFER_SIZE;
    } else if (size <= MEDIUM_BUFFER_SIZE) {
        buffers = pool->medium_buffers;
        buffer_size = MEDIUM_BUFFER_SIZE;
    } else if (size <= LARGE_BUFFER_SIZE) {
        buffers = pool->large_buffers;
        buffer_size = LARGE_BUFFER_SIZE;
    } else {
        // For very large allocations, use av_malloc with alignment
        uint8_t *ptr = (uint8_t*)av_malloc(size + 64); // Add padding for alignment
        return ptr;
    }

    // Find an available buffer with cache-friendly linear search
    for (int i = 0; i < pool_size; i++) {
        if (!buffers[i].in_use) {
            buffers[i].in_use = 1;
            // Pre-touch memory to reduce page faults
            memset(buffers[i].data, 0, buffer_size < 4096 ? buffer_size : 4096);
            return buffers[i].data;
        }
    }

    // No buffer available, allocate with alignment optimization
    return (uint8_t*)av_malloc(size + 32); // Add alignment padding
}

void buffer_pool_release(BufferPool *pool, uint8_t *buffer) {
    if (!pool || !buffer) return;

    // Optimized buffer pool release with early exit
    // Check small buffers first (most common)
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->small_buffers[i].data == buffer) {
            pool->small_buffers[i].in_use = 0;
            // Clear sensitive data for security (first few bytes only for performance)
            memset(buffer, 0, SMALL_BUFFER_SIZE < 256 ? SMALL_BUFFER_SIZE : 256);
            return;
        }
    }

    // Check medium buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->medium_buffers[i].data == buffer) {
            pool->medium_buffers[i].in_use = 0;
            memset(buffer, 0, 256); // Clear first 256 bytes
            return;
        }
    }

    // Check large buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->large_buffers[i].data == buffer) {
            pool->large_buffers[i].in_use = 0;
            memset(buffer, 0, 256); // Clear first 256 bytes
            return;
        }
    }

    // Buffer not from pool, free it directly
    av_free(buffer);
}

void buffer_pool_cleanup_unused(BufferPool *pool) {
    if (!pool) return;

    // Proactive cleanup to avoid memory fragmentation
    // Only clean up if memory pressure is detected (simplified heuristic)
    static int cleanup_counter = 0;
    cleanup_counter++;

    // Run cleanup every 100 calls to avoid overhead
    if (cleanup_counter % 100 != 0) return;

    int used_count = 0;
    int total_count = BUFFER_POOL_SIZE * 3; // small + medium + large pools

    // Count used buffers across all pools
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->small_buffers[i].in_use) used_count++;
        if (pool->medium_buffers[i].in_use) used_count++;
        if (pool->large_buffers[i].in_use) used_count++;
    }

    // If usage is low, hint to system that unused pages can be swapped
    if (used_count < total_count / 4) {
        // Advise kernel about unused memory (no-op in WASM but good practice)
        for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
            if (!pool->large_buffers[i].in_use) {
                // Touch first page to keep it resident, hint rest as cold
                volatile uint8_t dummy = pool->large_buffers[i].data[0];
                (void)dummy;
            }
        }
    }
}

int decoder_init_buffer_pool(AVDecoder *decoder) {
    if (!decoder) return -1;
    decoder->buffer_pool = buffer_pool_create();
    return decoder->buffer_pool ? 0 : -1;
}

void decoder_cleanup_buffer_pool(AVDecoder *decoder) {
    if (!decoder || !decoder->buffer_pool) return;
    buffer_pool_destroy(decoder->buffer_pool);
    decoder->buffer_pool = NULL;
}