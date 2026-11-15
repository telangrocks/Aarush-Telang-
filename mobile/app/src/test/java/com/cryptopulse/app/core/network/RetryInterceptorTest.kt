package com.cryptopulse.app.core.network

import com.cryptopulse.app.di.AppModule
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okio.Timeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

class RetryInterceptorTest {

    private val interceptor = AppModule.RetryInterceptor()

    private fun buildChain(
        request: Request,
        canceledProvider: () -> Boolean = { false },
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
            override fun call(): Call = object : Call {
                override fun request(): Request = request
                override fun execute(): Response = throw UnsupportedOperationException()
                override fun enqueue(responseCallback: Callback) = throw UnsupportedOperationException()
                override fun cancel() {}
                override fun isExecuted(): Boolean = calls > 0
                override fun isCanceled(): Boolean = canceledProvider()
                override fun timeout(): Timeout = Timeout.NONE
                override fun clone(): Call = this
            }
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

    @Test
    fun testPostLogin_doesNotRetryOn429() {
        val request = Request.Builder()
            .url("https://crypto-pulse-backend.telangrocks.workers.dev/api/login")
            .post(okhttp3.RequestBody.create(null, ByteArray(57)))
            .build()

        var callCount = 0

        val chain = buildChain(request) { _, count ->
            callCount = count
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(429)
                .message("Too Many Requests")
                .body(okhttp3.ResponseBody.create(null, "{\"error\":\"Too many login attempts. Please try again later.\"}"))
                .build()
        }

        val response = interceptor.intercept(chain)
        assertEquals(429, response.code)
        assertEquals(1, callCount) // MUST NOT RETRY POST /api/login
    }

    @Test
    fun testGetRequest_retriesOn500_andSucceeds() {
        val request = Request.Builder().url("http://test.com/api/market/ticker?symbol=ENA/USDT").get().build()
        var callCount = 0

        val chain = buildChain(request) { _, count ->
            callCount = count
            if (count < 2) {
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(500)
                    .message("Internal Server Error")
                    .body(okhttp3.ResponseBody.create(null, "500 error"))
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
    fun testPostTradingExecution_doesNotRetryOn500() {
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
                .code(500)
                .message("Internal Server Error")
                .body(okhttp3.ResponseBody.create(null, "500 error"))
                .build()
        }

        val response = interceptor.intercept(chain)
        assertEquals(500, response.code)
        assertEquals(1, callCount) // MUST NOT RETRY MUTATIONS
    }

    @Test
    fun testGetRequest_abortsImmediatelyOnIOExceptionWhenCanceled() {
        val request = Request.Builder().url("http://test.com/api/market/ticker?symbol=ETH/USDT").get().build()
        var callCount = 0
        var canceled = false
        val startNs = System.nanoTime()

        val chain = buildChain(request, canceledProvider = { canceled }) { _, count ->
            callCount = count
            canceled = true
            throw IOException("Canceled")
        }

        try {
            interceptor.intercept(chain)
            fail("Expected IOException when canceled")
        } catch (e: IOException) {
            assertEquals("Canceled", e.message)
        }
        val elapsedMs = (System.nanoTime() - startNs) / 1_000_000L
        assertEquals(1, callCount)
        assertTrue("Cancelled IOException must abort immediately without retry sleep (elapsed=${elapsedMs}ms)", elapsedMs < 500L)
    }

    @Test
    fun testGetRequest_abortsImmediatelyOn503WhenCanceled() {
        val request = Request.Builder().url("http://test.com/api/market/ticker?symbol=ETH/USDT").get().build()
        var callCount = 0
        var canceled = false
        val startNs = System.nanoTime()

        val chain = buildChain(request, canceledProvider = { canceled }) { _, count ->
            callCount = count
            canceled = true
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(503)
                .message("Service Unavailable")
                .body(okhttp3.ResponseBody.create(null, "503 error"))
                .build()
        }

        try {
            interceptor.intercept(chain)
            fail("Expected IOException on canceled 503")
        } catch (e: IOException) {
            assertEquals("Canceled", e.message)
        }
        val elapsedMs = (System.nanoTime() - startNs) / 1_000_000L
        assertEquals(1, callCount)
        assertTrue("Cancelled 503 must abort immediately without retry sleep (elapsed=${elapsedMs}ms)", elapsedMs < 500L)
    }

    @Test
    fun testGetRequest_abortsAfterBackoffIfCanceledBeforeNextRetry() {
        val request = Request.Builder().url("http://test.com/api/market/ticker?symbol=ETH/USDT").get().build()
        var callCount = 0
        val cancelCheckCount = AtomicInteger(0)

        // Pre-loop checks (checks 1..3) see not canceled so retry backoff begins;
        // post-sleep check (check >= 4) sees canceled and aborts before attempt 2.
        val chain = buildChain(request, canceledProvider = { cancelCheckCount.incrementAndGet() >= 4 }) { _, count ->
            callCount = count
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(429)
                .header("Retry-After", "0")
                .message("Too Many Requests")
                .body(okhttp3.ResponseBody.create(null, "429"))
                .build()
        }

        try {
            interceptor.intercept(chain)
            fail("Expected IOException when canceled during backoff")
        } catch (e: IOException) {
            assertEquals("Canceled", e.message)
        }
        assertEquals("Second upstream attempt must not fire if canceled during backoff", 1, callCount)
    }
}
