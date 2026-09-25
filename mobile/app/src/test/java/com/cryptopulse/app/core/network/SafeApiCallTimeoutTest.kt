package com.cryptopulse.app.core.network

import com.cryptopulse.app.core.error.NetworkError
import com.cryptopulse.app.domain.models.DomainException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.InterruptedIOException
import java.net.SocketTimeoutException

class SafeApiCallTimeoutTest {

    @Test
    fun `safeApiCall converts SocketTimeoutException to NetworkError Timeout`() = runTest {
        val result = safeApiCall<String> {
            throw SocketTimeoutException("Read timed out")
        }

        assertTrue(result is NetworkResult.Error)
        assertEquals(NetworkError.Timeout, (result as NetworkResult.Error).error)
    }

    @Test
    fun `safeApiCall converts InterruptedIOException to NetworkError Timeout`() = runTest {
        val result = safeApiCall<String> {
            throw InterruptedIOException("timeout")
        }

        assertTrue(result is NetworkResult.Error)
        assertEquals(NetworkError.Timeout, (result as NetworkResult.Error).error)
    }

    @Test
    fun `NetworkResult onFailure converts NetworkError Timeout to clean DomainException`() {
        val result: NetworkResult<String> = NetworkResult.Error(NetworkError.Timeout)
        var capturedException: Throwable? = null

        result.onFailure { capturedException = it }

        assertTrue(capturedException is DomainException)
        val domainEx = capturedException as DomainException
        assertEquals("Connection timeout. Please check your network and try again.", domainEx.message)
        assertEquals("TIMEOUT", domainEx.code)
    }

    @Test
    fun `NetworkResult exceptionOrNull converts NetworkError Timeout to clean DomainException`() {
        val result: NetworkResult<String> = NetworkResult.Error(NetworkError.Timeout)
        val ex = result.exceptionOrNull()

        assertTrue(ex is DomainException)
        val domainEx = ex as DomainException
        assertEquals("Connection timeout. Please check your network and try again.", domainEx.message)
        assertEquals("TIMEOUT", domainEx.code)
    }
}
