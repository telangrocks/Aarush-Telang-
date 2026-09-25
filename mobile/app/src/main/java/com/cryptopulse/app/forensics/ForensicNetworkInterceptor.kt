package com.cryptopulse.app.forensics

import android.util.Log
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException

/**
 * Passive, non-interfering OkHttp interceptor that records network latency,
 * response codes, timeouts, and transport errors for ShrikantTelang_ForensicCID.
 * Strictly OBSERVATION-ONLY: Never modifies requests, responses, or headers.
 */
class ForensicNetworkInterceptor(
    private val onNetworkObserved: (
        endpoint: String,
        method: String,
        statusCode: Int,
        durationMs: Long,
        contentLength: Long,
        error: String?
    ) -> Unit
) : Interceptor {

    companion object {
        private const val TAG = "ForensicNetwork"
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()
        val correlationId = originalRequest.header("X-Correlation-Id") ?: java.util.UUID.randomUUID().toString()
        val request = originalRequest.newBuilder()
            .header("X-Correlation-Id", correlationId)
            .build()
        val url = request.url
        val path = url.encodedPath
        val method = request.method
        val startNs = System.nanoTime()

        // Filter: We specifically track market, trading bot, auth, and exchange endpoints
        val isTargetEndpoint = path.contains("/api/trading-bot/") ||
                path.contains("/api/market/") ||
                path.contains("/api/strategies") ||
                path.contains("/api/exchange/") ||
                path.contains("/api/auth/") ||
                path.contains("/api/user/")

        var response: Response? = null
        var caughtException: IOException? = null

        try {
            response = chain.proceed(request)
            return response
        } catch (e: SocketTimeoutException) {
            caughtException = e
            throw e
        } catch (e: IOException) {
            caughtException = e
            throw e
        } finally {
            if (isTargetEndpoint && !path.endsWith("/api/cid/events")) {
                val durationMs = (System.nanoTime() - startNs) / 1_000_000
                val statusCode = response?.code ?: if (caughtException is SocketTimeoutException) 408 else 0
                val length = response?.body?.contentLength() ?: -1L
                val retryAfter = if (statusCode == 429) response?.header("retry-after") else null
                val errorMsg = if (statusCode == 429) {
                    if (retryAfter != null) "HTTP 429 (retry-after: $retryAfter)" else "HTTP 429"
                } else {
                    caughtException?.message ?: if (statusCode >= 400) "HTTP $statusCode" else null
                }
                val cfRay = response?.header("cf-ray")

                try {
                    onNetworkObserved(path, method, statusCode, durationMs, length, errorMsg)
                    if (statusCode == 429) {
                        CidDiagnosticManager.logRateLimitCloudflare(
                            path = path,
                            method = method,
                            durationMs = durationMs,
                            contentLength = length,
                            cfRay = cfRay,
                            retryAfter = retryAfter
                        )
                    } else {
                        CidDiagnosticManager.logNetwork(
                            method = method,
                            path = path,
                            statusCode = statusCode,
                            durationMs = durationMs,
                            contentLength = length,
                            cfRay = cfRay,
                            error = errorMsg,
                            correlationId = correlationId
                        )
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "Error notifying network forensic event: ${t.message}")
                }
            }
        }
    }
}
