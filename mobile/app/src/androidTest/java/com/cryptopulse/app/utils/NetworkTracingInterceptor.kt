package com.cryptopulse.app.utils

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.Interceptor
import okhttp3.Response
import java.io.File
import java.io.FileWriter

class NetworkTracingInterceptor : Interceptor {
    private val tag = "NetworkTracing"

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val startTime = System.currentTimeMillis()

        val response: Response = try {
            chain.proceed(request)
        } catch (e: Exception) {
            val latency = System.currentTimeMillis() - startTime
            logTrace(request.method, request.url.toString(), 0, latency, e.message ?: "Network Exception")
            throw e
        }

        val latency = System.currentTimeMillis() - startTime
        logTrace(request.method, request.url.toString(), response.code, latency, null)
        return response
    }

    private fun logTrace(method: String, url: String, statusCode: Int, latencyMs: Long, error: String?) {
        try {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val dir = File(context.getExternalFilesDir(null), "network").apply { mkdirs() }

            val summaryFile = File(dir, "network_summary.log")
            FileWriter(summaryFile, true).use { writer ->
                val statusStr = if (error != null) "ERROR ($error)" else "HTTP $statusCode"
                writer.appendLine("[$method] $url -> $statusStr (${latencyMs}ms)")
            }

            val jsonFile = File(dir, "rest_trace.json")
            FileWriter(jsonFile, true).use { writer ->
                val jsonEntry = """{"method":"$method","url":"$url","statusCode":$statusCode,"latencyMs":$latencyMs,"error":${error?.let { "\"$it\"" } ?: "null"}}"""
                writer.appendLine(jsonEntry)
            }
            Log.d(tag, "Traced $method $url -> HTTP $statusCode in ${latencyMs}ms")
        } catch (e: Exception) {
            Log.e(tag, "Failed to write network trace: ${e.message}")
        }
    }
}
