package com.cryptopulse.app.data.repository

import com.cryptopulse.app.core.dispatcher.DispatcherProvider
import com.cryptopulse.app.core.network.NetworkResult
import com.cryptopulse.app.data.api.dto.strategy.response.StrategyDiscoveryResponseDto
import com.cryptopulse.app.data.api.dto.strategy.response.StrategyManifestDto
import com.cryptopulse.app.data.datasource.remote.strategy.StrategyRemoteDataSource
import kotlinx.coroutines.*
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

@OptIn(ExperimentalCoroutinesApi::class)
class StrategyRepositoryConcurrencyTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var dispatcherProvider: DispatcherProvider
    private lateinit var fakeRemoteDataSource: ConcurrencyFakeStrategyRemoteDataSource
    private lateinit var repository: StrategyRepositoryImpl

    @Before
    fun setup() {
        dispatcherProvider = object : DispatcherProvider {
            override val main: CoroutineDispatcher = testDispatcher
            override val io: CoroutineDispatcher = testDispatcher
            override val default: CoroutineDispatcher = testDispatcher
            override val unconfined: CoroutineDispatcher = testDispatcher
        }
        fakeRemoteDataSource = ConcurrencyFakeStrategyRemoteDataSource()
        repository = StrategyRepositoryImpl(
            strategyRemoteDataSource = fakeRemoteDataSource,
            dispatcherProvider = dispatcherProvider
        )
    }

    @Test
    fun `concurrent calls to getStrategies should dispatch exactly one network request`() = runTest {
        repository = StrategyRepositoryImpl(
            strategyRemoteDataSource = fakeRemoteDataSource,
            dispatcherProvider = dispatcherProvider,
            externalScope = backgroundScope
        )

        val callersCount = 10
        val results = mutableListOf<Deferred<NetworkResult<*>>>()

        coroutineScope {
            repeat(callersCount) {
                results.add(async {
                    repository.getStrategies()
                })
            }
        }

        val allResults = results.awaitAll()
        assertEquals(10, allResults.size)
        allResults.forEach { res ->
            assertTrue(res is NetworkResult.Success)
        }

        // Exactly 1 network request should be dispatched across all 10 callers!
        assertEquals(1, fakeRemoteDataSource.apiCallCount.get())
    }

    @Test
    fun `clearCache forces a new network request on subsequent fetch`() = runTest {
        repository = StrategyRepositoryImpl(
            strategyRemoteDataSource = fakeRemoteDataSource,
            dispatcherProvider = dispatcherProvider,
            externalScope = backgroundScope
        )

        val firstResult = repository.getStrategies()
        assertTrue(firstResult is NetworkResult.Success)
        assertEquals(1, fakeRemoteDataSource.apiCallCount.get())

        // Cached call
        val secondResult = repository.getStrategies()
        assertTrue(secondResult is NetworkResult.Success)
        assertEquals(1, fakeRemoteDataSource.apiCallCount.get())

        // Clear cache (e.g. during logout)
        repository.clearCache()

        // Fetch again -> should trigger a new network call
        val thirdResult = repository.getStrategies()
        assertTrue(thirdResult is NetworkResult.Success)
        assertEquals(2, fakeRemoteDataSource.apiCallCount.get())
    }
}

private class ConcurrencyFakeStrategyRemoteDataSource : StrategyRemoteDataSource {
    val apiCallCount = AtomicInteger(0)

    override suspend fun getAvailableStrategies(): NetworkResult<StrategyDiscoveryResponseDto> {
        apiCallCount.incrementAndGet()
        return NetworkResult.Success(
            StrategyDiscoveryResponseDto(
                version = "1.0",
                count = 1,
                strategies = listOf(
                    StrategyManifestDto(
                        id = "ScalperV2",
                        displayName = "Scalper V2",
                        description = "High frequency scalper",
                        category = "SCALPING",
                        riskProfile = "MEDIUM"
                    )
                )
            )
        )
    }
}
