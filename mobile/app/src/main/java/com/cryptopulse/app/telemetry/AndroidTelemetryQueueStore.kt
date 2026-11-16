package com.cryptopulse.app.telemetry

import java.io.File
import java.nio.charset.StandardCharsets

/**
 * Bounded, file-backed FIFO queue storing serialized Stage 9 telemetry JSON objects
 * (NDJSON format: one compacted JSON object per line).
 *
 * Guarantees:
 * - Bounded at [maxEvents] (`<= 200`): drops oldest entries when full rather than throwing or OOMing.
 * - Atomic temp-file rewrite so crashes never leave half-written lines.
 * - Batch slicing enforces backend `/api/client/telemetry` limits (`<= 25` events and `<= 28 KB` body).
 */
class AndroidTelemetryQueueStore(
    private val queueFile: File,
    private val maxEvents: Int = DEFAULT_MAX_EVENTS,
    private val maxBatchEvents: Int = DEFAULT_MAX_BATCH_EVENTS,
    private val maxBatchBytes: Int = DEFAULT_MAX_BATCH_BYTES
) {
    private val lock = Any()

    data class PendingBatch(
        val payloadJson: String,
        val count: Int
    )

    fun enqueue(event: Stage9TelemetryEvent): Boolean {
        return enqueueJson(event.toJsonString())
    }

    fun enqueueJson(serializedJson: String): Boolean {
        val compact = serializedJson.replace('\n', ' ').replace('\r', ' ').trim()
        if (compact.isEmpty() || compact.toByteArray(StandardCharsets.UTF_8).size > maxBatchBytes - 32) {
            return false
        }
        synchronized(lock) {
            return try {
                val lines = readAllLinesLocked().toMutableList()
                lines.add(compact)
                while (lines.size > maxEvents) {
                    lines.removeAt(0)
                }
                writeAllLinesLocked(lines)
                true
            } catch (_: Throwable) {
                false
            }
        }
    }

    fun size(): Int {
        synchronized(lock) {
            return try {
                readAllLinesLocked().size
            } catch (_: Throwable) {
                0
            }
        }
    }

    /**
     * Reads up to [maxBatchEvents] events without removing them yet, respecting [maxBatchBytes]
     * for the final `{ "events": [...] }` HTTP body.
     */
    fun peekBatch(): PendingBatch? {
        synchronized(lock) {
            val lines = try {
                readAllLinesLocked()
            } catch (_: Throwable) {
                return null
            }
            if (lines.isEmpty()) return null

            val selected = ArrayList<String>(minOf(lines.size, maxBatchEvents))
            var bodyBytes = 14 // {"events":[]} + comma overhead
            for (line in lines) {
                if (selected.size >= maxBatchEvents) break
                val lineBytes = line.toByteArray(StandardCharsets.UTF_8).size + (if (selected.isEmpty()) 0 else 1)
                if (selected.isNotEmpty() && bodyBytes + lineBytes > maxBatchBytes) {
                    break
                }
                selected.add(line)
                bodyBytes += lineBytes
            }
            if (selected.isEmpty()) return null
            return PendingBatch(
                payloadJson = Stage9Json.encodeBatchPayload(selected),
                count = selected.size
            )
        }
    }

    fun dropHead(count: Int) {
        if (count <= 0) return
        synchronized(lock) {
            try {
                val lines = readAllLinesLocked()
                if (count >= lines.size) {
                    if (queueFile.exists()) queueFile.delete()
                } else {
                    writeAllLinesLocked(lines.drop(count))
                }
            } catch (_: Throwable) {
                // Fail-open
            }
        }
    }

    fun clear() {
        synchronized(lock) {
            try {
                if (queueFile.exists()) queueFile.delete()
            } catch (_: Throwable) {
                // Fail-open
            }
        }
    }

    private fun readAllLinesLocked(): List<String> {
        if (!queueFile.exists()) return emptyList()
        return queueFile.readLines(StandardCharsets.UTF_8)
            .map { it.trim() }
            .filter { it.startsWith("{") && it.endsWith("}") }
    }

    private fun writeAllLinesLocked(lines: List<String>) {
        val parent = queueFile.parentFile
        if (parent != null && !parent.exists()) {
            parent.mkdirs()
        }
        val tmpFile = File(parent ?: File("."), "${queueFile.name}.tmp")
        val content = if (lines.isEmpty()) "" else lines.joinToString("\n", postfix = "\n")
        tmpFile.writeText(content, StandardCharsets.UTF_8)
        if (!tmpFile.renameTo(queueFile)) {
            queueFile.writeText(content, StandardCharsets.UTF_8)
            tmpFile.delete()
        }
    }

    companion object {
        const val DEFAULT_MAX_EVENTS = 200
        const val DEFAULT_MAX_BATCH_EVENTS = 25
        const val DEFAULT_MAX_BATCH_BYTES = 28 * 1024
        const val QUEUE_FILENAME = "stage9_telemetry_queue.ndjson"
    }
}
