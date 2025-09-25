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

    // Select appropriate buffer pool
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
        // Size too large for pool, allocate directly
        return (uint8_t*)av_malloc(size);
    }

    // Find an available buffer
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (!buffers[i].in_use) {
            buffers[i].in_use = 1;
            return buffers[i].data;
        }
    }

    // No buffer available, allocate a new one
    return (uint8_t*)av_malloc(size);
}

void buffer_pool_release(BufferPool *pool, uint8_t *buffer) {
    if (!pool || !buffer) return;

    // Check small buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->small_buffers[i].data == buffer) {
            pool->small_buffers[i].in_use = 0;
            return;
        }
    }

    // Check medium buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->medium_buffers[i].data == buffer) {
            pool->medium_buffers[i].in_use = 0;
            return;
        }
    }

    // Check large buffers
    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->large_buffers[i].data == buffer) {
            pool->large_buffers[i].in_use = 0;
            return;
        }
    }

    // Buffer not from pool, free it directly
    av_free(buffer);
}

void buffer_pool_cleanup_unused(BufferPool *pool) {
    // This implementation keeps all buffers allocated
    // No cleanup needed for fixed-size pool
    if (!pool) return;
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