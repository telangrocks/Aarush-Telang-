package com.cryptopulse.app.core.network

import com.cryptopulse.app.di.AppModule
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

class RetryInterceptorTest {

    private val interceptor = AppModule.RetryInterceptor()

    private fun buildChain(
        request: Request,
        action: (Interceptor.Chain, Int) -> Response
    ): Interceptor.Chain {
        return object : Interceptor.Chain {
            var calls = 0
            override fun request(): Request = request
            
            override fun proceed(request: Request): Response {
                calls++
                return action(this, calls)
            }
            
            override fun connection() = null
            override fun call() = throw UnsupportedOperationException()
            override fun connectTimeoutMillis() = 0
            override fun withConnectTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
            override fun readTimeoutMillis() = 0
            override fun withReadTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
            override fun writeTimeoutMillis() = 0
            override fun withWriteTimeout(timeout: Int, unit: java.util.concurrent.TimeUnit) = this
        }
    }

    @Test
    fun testGetRequest_retriesOnIOException() {
        val request = Request.Builder().url("http://test.com").get().build()
        var callCount = 0
        
        val chain = buildChain(request) { _, count ->
            callCount = count
            if (count < 2) {
                throw IOException("Network error")
            }
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .build()
        }

        val response = interceptor.intercept(chain)
        assertEquals(200, response.code)
        assertEquals(2, callCount)
    }

    @Test
    fun testPostRequest_doesNotRetryOnIOException() {
        val request = Request.Builder()
            .url("http://test.com/api/trading-bot/activate")
            .post(okhttp3.RequestBody.create(null, ByteArray(0)))
            .build()
            
        var callCount = 0
        
        val chain = buildChain(request) { _, count ->
            callCount = count
            throw IOException("Network error")
        }

        try {
            interceptor.intercept(chain)
            fail("Expected IOException")
        } catch (e: IOException) {
            assertEquals("Network error", e.message)
        }
        
        assertEquals(1, callCount)
    }

    @Test
    fun testPutRequest_doesNotRetryOnIOException() {
        val request = Request.Builder()
            .url("http://test.com/api/test")
            .put(okhttp3.RequestBody.create(null, ByteArray(0)))
            .build()
            
        var callCount = 0
        
        val chain = buildChain(request) { _, count ->
            callCount = count
            throw IOException("Network error")
        }

        try {
            interceptor.intercept(chain)
            fail("Expected IOException")
        } catch (e: IOException) {
            assertEquals("Network error", e.message)
        }
        
        assertEquals(1, callCount)
    }

    @Test
    fun testGetRequest_exceedsMaxRetries_throwsException() {
        val request = Request.Builder().url("http://test.com").get().build()
        var callCount = 0
        
        val chain = buildChain(request) { _, count ->
            callCount = count
            throw IOException("Network error")
        }

        try {
            interceptor.intercept(chain)
            fail("Expected IOException")
        } catch (e: IOException) {
            assertEquals("Network error", e.message)
        }
        assertEquals(3, callCount)
    }

    @Test
    fun testGetRequest_retriesOn503_andSucceeds() {
        val request = Request.Builder().url("http://test.com/api/market/candidates").get().build()
        var callCount = 0

        val chain = buildChain(request) { _, count ->
            callCount = count
            if (count < 2) {
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(503)
                    .message("Service Unavailable")
                    .body(okhttp3.ResponseBody.create(null, "503 error"))
                    .build()
            } else {
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(okhttp3.ResponseBody.create(null, "ok"))
                    .build()
            }
        }

        val response = interceptor.intercept(chain)
        assertEquals(200, response.code)
        assertEquals(2, callCount)
    }

    @Test
    fun testGetRequest_retriesOn429_withRetryAfter() {
        val request = Request.Builder().url("http://test.com/api/market/candidates").get().build()
        var callCount = 0

        val chain = buildChain(request) { _, count ->
            callCount = count
            if (count < 2) {
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(429)
                    .header("Retry-After", "1")
                    .message("Too Many Requests")
                    .body(okhttp3.ResponseBody.create(null, "429 error"))
                    .build()
            } else {
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(okhttp3.ResponseBody.create(null, "ok"))
                    .build()
            }
        }

        val response = interceptor.intercept(chain)
        assertEquals(200, response.code)
        assertEquals(2, callCount)
    }

    @Test
    fun testPostTradingExecution_doesNotRetryOn503() {
        val request = Request.Builder()
            .url("http://test.com/api/trading-bot/execute-trade")
            .post(okhttp3.RequestBody.create(null, ByteArray(0)))
            .build()

        var callCount = 0

        val chain = buildChain(request) { _, count ->
            callCount = count
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(503)
                .message("Service Unavailable")
                .body(okhttp3.ResponseBody.create(null, "503 error"))
                .build()
        }

        val response = interceptor.intercept(chain)
        assertEquals(503, response.code)
        assertEquals(1, callCount) // MUST NOT RETRY MUTATIONS
    }

    @Test
    fun testPostTradingExecution_doesNotRetryOn429() {
        val request = Request.Builder()
            .url("http://test.com/api/trading-bot/execute-trade")
            .post(okhttp3.RequestBody.create(null, ByteArray(0)))
            .build()

        var callCount = 0

        val chain = buildChain(request) { _, count ->
            callCount = count
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(429)
                .message("Too Many Requests")
                .body(okhttp3.ResponseBody.create(null, "429 error"))
                .build()
        }

        val response = interceptor.intercept(chain)
        assertEquals(429, response.code)
        assertEquals(1, callCount) // MUST NOT RETRY MUTATIONS
    }
}
