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


int write_to_buffer(void *opaque, const uint8_t *buf, int buf_size) {
    if (!track_extract_buffer) {
        return AVERROR(EINVAL);
    }

    if (track_extract_buffer_size + buf_size > MAX_EXTRACT_BUFFER_SIZE) {
        return AVERROR(ENOMEM);
    }

    while (track_extract_buffer_size + buf_size > track_extract_buffer_capacity) {
        int new_capacity = track_extract_buffer_capacity * 2;
        if (new_capacity > MAX_EXTRACT_BUFFER_SIZE) {
            new_capacity = MAX_EXTRACT_BUFFER_SIZE;
        }
        if (new_capacity < track_extract_buffer_size + buf_size) {
            new_capacity = track_extract_buffer_size + buf_size;
        }

        uint8_t *new_buffer = (uint8_t*)realloc(track_extract_buffer, new_capacity);
        if (!new_buffer) {
            return AVERROR(ENOMEM);
        }

        track_extract_buffer = new_buffer;
        track_extract_buffer_capacity = new_capacity;
    }

    memcpy(track_extract_buffer + track_extract_buffer_size, buf, buf_size);
    track_extract_buffer_size += buf_size;
    return buf_size;
}

int64_t seek_in_buffer(void *opaque, int64_t offset, int whence) {
    if (whence == AVSEEK_SIZE) {
        return track_extract_buffer_size;
    }

    int64_t new_pos;
    switch (whence) {
        case SEEK_SET:
            new_pos = offset;
            break;
        case SEEK_CUR:
            new_pos = track_extract_buffer_size + offset;
            break;
        case SEEK_END:
            new_pos = track_extract_buffer_size + offset;
            break;
        default:
            return AVERROR(EINVAL);
    }

    if (new_pos < 0) {
        return AVERROR(EINVAL);
    }

    if (new_pos > track_extract_buffer_size) {
        while (new_pos > track_extract_buffer_capacity) {
            int new_capacity = track_extract_buffer_capacity * 2;
            if (new_capacity < new_pos) {
            }
            if (new_capacity > MAX_EXTRACT_BUFFER_SIZE) {
                new_capacity = MAX_EXTRACT_BUFFER_SIZE;
            }

            uint8_t *new_buffer = (uint8_t*)realloc(track_extract_buffer, new_capacity);
            if (!new_buffer) {
                return AVERROR(ENOMEM);
            }

            track_extract_buffer = new_buffer;
            track_extract_buffer_capacity = new_capacity;
        }

        if (new_pos > track_extract_buffer_size) {
            memset(track_extract_buffer + track_extract_buffer_size, 0, new_pos - track_extract_buffer_size);
            track_extract_buffer_size = new_pos;
        }
    }

    return new_pos;
}


BufferPool* buffer_pool_create(void) {
    BufferPool *pool = (BufferPool*)calloc(1, sizeof(BufferPool));
    if (!pool) return NULL;

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        pool->small_buffers[i].data = (uint8_t*)malloc(SMALL_BUFFER_SIZE);
        pool->small_buffers[i].size = SMALL_BUFFER_SIZE;
        pool->small_buffers[i].in_use = 0;

        if (!pool->small_buffers[i].data) {
            buffer_pool_destroy(pool);
            return NULL;
        }
    }

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        pool->medium_buffers[i].data = (uint8_t*)malloc(MEDIUM_BUFFER_SIZE);
        pool->medium_buffers[i].size = MEDIUM_BUFFER_SIZE;
        pool->medium_buffers[i].in_use = 0;

        if (!pool->medium_buffers[i].data) {
            buffer_pool_destroy(pool);
            return NULL;
        }
    }

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        pool->large_buffers[i].data = (uint8_t*)malloc(LARGE_BUFFER_SIZE);
        pool->large_buffers[i].size = LARGE_BUFFER_SIZE;
        pool->large_buffers[i].in_use = 0;

        if (!pool->large_buffers[i].data) {
            buffer_pool_destroy(pool);
            return NULL;
        }
    }

    pool->initialized = 1;
    return pool;
}

void buffer_pool_destroy(BufferPool *pool) {
    if (!pool) return;

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->small_buffers[i].data) {
            free(pool->small_buffers[i].data);
        }
    }

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->medium_buffers[i].data) {
            free(pool->medium_buffers[i].data);
        }
    }

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->large_buffers[i].data) {
            free(pool->large_buffers[i].data);
        }
    }

    free(pool);
}

uint8_t* buffer_pool_get(BufferPool *pool, int size) {
    if (!pool || !pool->initialized) return malloc(size);

    PooledBuffer *buffers = NULL;
    int pool_size = 0;

    if (size <= SMALL_BUFFER_SIZE) {
        buffers = pool->small_buffers;
        pool_size = BUFFER_POOL_SIZE;
    } else if (size <= MEDIUM_BUFFER_SIZE) {
        buffers = pool->medium_buffers;
        pool_size = BUFFER_POOL_SIZE;
    } else if (size <= LARGE_BUFFER_SIZE) {
        buffers = pool->large_buffers;
        pool_size = BUFFER_POOL_SIZE;
    } else {
        return malloc(size);
    }

    for (int i = 0; i < pool_size; i++) {
        if (!buffers[i].in_use && buffers[i].data) {
            buffers[i].in_use = 1;
            return buffers[i].data;
        }
    }

    return malloc(size);
}

void buffer_pool_release(BufferPool *pool, uint8_t *buffer) {
    if (!pool || !pool->initialized || !buffer) {
        free(buffer);
        return;
    }

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->small_buffers[i].data == buffer) {
            pool->small_buffers[i].in_use = 0;
            return;
        }
    }

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->medium_buffers[i].data == buffer) {
            pool->medium_buffers[i].in_use = 0;
            return;
        }
    }

    for (int i = 0; i < BUFFER_POOL_SIZE; i++) {
        if (pool->large_buffers[i].data == buffer) {
            pool->large_buffers[i].in_use = 0;
            return;
        }
    }

    free(buffer);
}

void buffer_pool_cleanup_unused(BufferPool *pool) {
    if (!pool || !pool->initialized) return;
}

EMSCRIPTEN_KEEPALIVE
int decoder_init_buffer_pool(AVDecoder *decoder) {
    if (!decoder) return -1;

    if (decoder->buffer_pool) {
        return 0;
    }

    decoder->buffer_pool = buffer_pool_create();
    return decoder->buffer_pool ? 0 : -1;
}

EMSCRIPTEN_KEEPALIVE
void decoder_cleanup_buffer_pool(AVDecoder *decoder) {
    if (!decoder || !decoder->buffer_pool) return;

    buffer_pool_destroy(decoder->buffer_pool);
    decoder->buffer_pool = NULL;
}