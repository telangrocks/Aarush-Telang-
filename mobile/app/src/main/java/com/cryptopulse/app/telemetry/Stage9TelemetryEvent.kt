package com.cryptopulse.app.telemetry

import java.util.Locale
import java.util.UUID

/**
 * Strongly-typed Stage 9 client telemetry event matching the backend
 * `/api/client/telemetry` ingestion contract (`PipelineTelemetryEvent` v2).
 */
data class Stage9TelemetryEvent(
    val spanId: String = UUID.randomUUID().toString(),
    val parentSpanId: String? = null,
    val contractVersion: Int = STAGE9_CONTRACT_VERSION,
    val journey: String = "JOURNEY_B_AUTONOMOUS",
    val stage: Int = 9,
    val tier: String = "TIER_1",
    val stageSeq: Long,
    val eventType: String,
    val status: String,
    val severity: String,
    val alertId: String? = null,
    val fcmMessageId: String? = null,
    val symbol: String? = null,
    val strategyId: String? = null,
    val timeframe: String? = null,
    val component: String,
    val message: String,
    val emittedAtMs: Long = System.currentTimeMillis(),
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val outputSummary: Map<String, Any?> = emptyMap()
) {
    fun toJsonString(): String = Stage9Json.encodeEvent(this)

    companion object {
        const val SCHEMA_VERSION = 2
        const val STAGE9_CONTRACT_VERSION = 1
    }

    object EventType {
        const val FCM_RECEIVED = "ANDROID_FCM_RECEIVED"
        const val POLL_RECEIVED = "ANDROID_POLL_RECEIVED"
        const val DEDUP_DECISION = "ANDROID_DEDUP_DECISION"
        const val NOTIFICATION_PRECHECK = "ANDROID_NOTIFICATION_PRECHECK"
        const val NOTIFICATION_POST_CHECK = "ANDROID_NOTIFICATION_POST_CHECK"
        const val ALERT_VALIDATED = "ANDROID_ALERT_VALIDATED"
        const val POPUP_RENDERED = "ANDROID_POPUP_RENDERED"
        const val TELEMETRY_FAILED = "ANDROID_TELEMETRY_FAILED"
    }

    object DedupDecision {
        const val ACCEPTED = "ACCEPTED"
        const val SUPPRESSED = "SUPPRESSED"
        const val DUPLICATE_DROPPED = "DUPLICATE_DROPPED"
    }

    object HeadsUpState {
        const val UNKNOWN = "UNKNOWN"
        const val ELIGIBLE_OS_UNPROVABLE = "ELIGIBLE_OS_UNPROVABLE"
        const val SUPPRESSED_PRECHECK = "SUPPRESSED_PRECHECK"
        const val POST_CHECK_MISSING = "POST_CHECK_MISSING"
    }

    object ValidationOutcome {
        const val PASS = "PASS"
        const val REJECTED = "REJECTED"
        const val FAILED = "FAILED"
    }
}

internal object Stage9Json {
    private val SENSITIVE_KEY_PATTERN = Regex(
        pattern = "(apikey|apisecret|apipassphrase|secret|password|passphrase|jwt|bearer|authorization|cookie|credential|privatekey|fcmtoken|devicetoken|refreshtoken|^token$)",
        option = RegexOption.IGNORE_CASE
    )
    private val BEARER_PATTERN = Regex("Bearer\\s+[A-Za-z0-9._-]+", RegexOption.IGNORE_CASE)
    private const val MAX_STRING_LEN = 512

    fun redactString(value: String): String {
        val noBearer = BEARER_PATTERN.replace(value, "Bearer [REDACTED]")
        return if (noBearer.length <= MAX_STRING_LEN) noBearer else noBearer.take(MAX_STRING_LEN) + "..."
    }

    fun sanitizeMap(raw: Map<String, Any?>): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(raw.size)
        for ((key, value) in raw) {
            if (isSensitiveKey(key)) {
                out[key] = "[REDACTED]"
            } else {
                out[key] = sanitizeAny(value)
            }
        }
        return out
    }

    private fun isSensitiveKey(key: String): Boolean {
        val normalized = key.replace("_", "").replace("-", "").trim()
        return SENSITIVE_KEY_PATTERN.containsMatchIn(normalized)
    }

    private fun sanitizeAny(value: Any?): Any? {
        return when (value) {
            null -> null
            is Boolean -> value
            is Int, is Long -> value
            is Double -> if (value.isFinite()) value else null
            is Float -> if (value.isFinite()) value.toDouble() else null
            is Number -> value.toDouble().let { if (it.isFinite()) it else null }
            is String -> redactString(value)
            is Map<*, *> -> {
                val nested = LinkedHashMap<String, Any?>(value.size)
                for ((k, v) in value) {
                    val keyStr = k?.toString() ?: continue
                    nested[keyStr] = if (isSensitiveKey(keyStr)) "[REDACTED]" else sanitizeAny(v)
                }
                nested
            }
            is Iterable<*> -> value.take(50).map { sanitizeAny(it) }
            is Array<*> -> value.take(50).map { sanitizeAny(it) }
            else -> redactString(value.toString())
        }
    }

    fun encodeEvent(event: Stage9TelemetryEvent): String {
        val map = LinkedHashMap<String, Any?>()
        map["schemaVersion"] = Stage9TelemetryEvent.SCHEMA_VERSION
        map["contractVersion"] = event.contractVersion
        map["spanId"] = event.spanId
        event.parentSpanId?.takeIf { it.isNotBlank() }?.let { map["parentSpanId"] = it }
        map["journey"] = event.journey
        map["stage"] = event.stage
        map["tier"] = event.tier
        map["stageSeq"] = event.stageSeq
        map["eventType"] = event.eventType
        map["status"] = event.status
        map["severity"] = event.severity
        event.alertId?.takeIf { it.isNotBlank() }?.let { map["alertId"] = redactString(it) }
        event.fcmMessageId?.takeIf { it.isNotBlank() }?.let { map["fcmMessageId"] = redactString(it) }
        event.symbol?.takeIf { it.isNotBlank() }?.let { map["symbol"] = it.uppercase(Locale.US).take(32) }
        event.strategyId?.takeIf { it.isNotBlank() }?.let { map["strategyId"] = redactString(it) }
        event.timeframe?.takeIf { it.isNotBlank() }?.let { map["timeframe"] = redactString(it) }
        map["component"] = redactString(event.component)
        map["message"] = redactString(event.message)
        map["emittedAtMs"] = event.emittedAtMs
        event.errorCode?.takeIf { it.isNotBlank() }?.let { map["errorCode"] = redactString(it) }
        event.errorMessage?.takeIf { it.isNotBlank() }?.let { map["errorMessage"] = redactString(it) }
        if (event.outputSummary.isNotEmpty()) {
            map["outputSummary"] = sanitizeMap(event.outputSummary)
        }
        return encodeMap(map)
    }

    fun encodeBatchPayload(eventJsonObjects: List<String>): String {
        val sb = StringBuilder(eventJsonObjects.sumOf { it.length } + 32)
        sb.append("{\"events\":[")
        eventJsonObjects.forEachIndexed { index, item ->
            if (index > 0) sb.append(',')
            sb.append(item)
        }
        sb.append("]}")
        return sb.toString()
    }

    private fun encodeMap(map: Map<String, Any?>): String {
        val sb = StringBuilder(128)
        sb.append('{')
        var first = true
        for ((k, v) in map) {
            if (!first) sb.append(',')
            first = false
            appendQuoted(sb, k)
            sb.append(':')
            appendValue(sb, v)
        }
        sb.append('}')
        return sb.toString()
    }

    private fun appendValue(sb: StringBuilder, value: Any?) {
        when (value) {
            null -> sb.append("null")
            is Boolean -> sb.append(if (value) "true" else "false")
            is Int, is Long -> sb.append(value.toString())
            is Double -> if (value.isFinite()) sb.append(value.toString()) else sb.append("null")
            is Float -> if (value.isFinite()) sb.append(value.toDouble().toString()) else sb.append("null")
            is Number -> sb.append(value.toString())
            is String -> appendQuoted(sb, value)
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    val key = k?.toString() ?: continue
                    if (!first) sb.append(',')
                    first = false
                    appendQuoted(sb, key)
                    sb.append(':')
                    appendValue(sb, v)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (item in value) {
                    if (!first) sb.append(',')
                    first = false
                    appendValue(sb, item)
                }
                sb.append(']')
            }
            else -> appendQuoted(sb, value.toString())
        }
    }

    private fun appendQuoted(sb: StringBuilder, str: String) {
        sb.append('"')
        for (ch in str) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> {
                    if (ch.code < 0x20) {
                        sb.append(String.format(Locale.US, "\\u%04x", ch.code))
                    } else {
                        sb.append(ch)
                    }
                }
            }
        }
        sb.append('"')
    }
}
