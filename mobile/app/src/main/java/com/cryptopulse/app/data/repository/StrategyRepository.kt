package com.cryptopulse.app.data.repository

import com.cryptopulse.app.domain.models.Strategy

interface StrategyRepository {
    suspend fun getStrategies(): Result<List<Strategy>>
    
    /**
     * Retrieves a strategy by its ID.
     * 
     * Why Result.success(null)?
     * A requested strategy might no longer exist in the backend (e.g., if it was retired or 
     * the user's tier no longer permits it). This is a valid business state, NOT a system failure.
     * Therefore, we return Result.success(null) to indicate the query succeeded but the item is absent.
     * Result.failure() is strictly reserved for network timeouts, 500s, or local parse errors.
     */
    suspend fun getStrategyById(id: String): Result<Strategy?>
}
