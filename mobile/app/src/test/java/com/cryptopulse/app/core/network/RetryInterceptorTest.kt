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
        
        assertEquals(2, callCount)
    }
}
