package com.cryptopulse.app.telemetry

import com.cryptopulse.app.BuildConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Isolated Stage 9 HTTP batch poster targeting `/api/client/telemetry`.
 * Strictly fail-open: never throws, never retries inline inside user-facing execution,
 * and respects 429/5xx backoff via [UploadOutcome].
 */
class AndroidTelemetryClient(
    private val okHttpClient: OkHttpClient,
    private val tokenProvider: suspend () -> String?,
    private val endpointUrl: String = DEFAULT_ENDPOINT_URL
) {
    sealed class UploadOutcome {
        data object Sent : UploadOutcome()
        data object MissingAuth : UploadOutcome()
        data class RateLimited(val retryAfterMs: Long) : UploadOutcome()
        data class DroppedInvalid(val httpCode: Int) : UploadOutcome()
        data class TransientFailure(val httpCode: Int?, val reason: String) : UploadOutcome()
    }

    suspend fun uploadBatch(payloadJson: String): UploadOutcome {
        val jwt = try {
            tokenProvider()?.trim()
        } catch (_: Throwable) {
            null
        }
        if (jwt.isNullOrEmpty()) {
            return UploadOutcome.MissingAuth
        }

        return try {
            val body = payloadJson.toRequestBody(JSON_MEDIA_TYPE)
            val request = Request.Builder()
                .url(endpointUrl)
                .header("Authorization", "Bearer $jwt")
                .header("Content-Type", "application/json")
                .post(body)
                .build()

            okHttpClient.newCall(request).execute().use { response ->
                val code = response.code
                when {
                    code in 200..299 -> UploadOutcome.Sent
                    code == 429 -> {
                        val retrySec = response.header("Retry-After")?.toLongOrNull() ?: 30L
                        UploadOutcome.RateLimited(retryAfterMs = retrySec.coerceIn(5L, 300L) * 1000L)
                    }
                    code in 400..499 && code != 401 && code != 408 -> {
                        // Malformed batch or permanently rejected schema should be dropped so the queue cannot poison itself.
                        UploadOutcome.DroppedInvalid(code)
                    }
                    else -> UploadOutcome.TransientFailure(code, "HTTP $code")
                }
            }
        } catch (t: Throwable) {
            UploadOutcome.TransientFailure(null, t.message ?: t.javaClass.simpleName)
        }
    }

    companion object {
        val DEFAULT_ENDPOINT_URL: String = BuildConfig.TELEMETRY_ENDPOINT_URL
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
