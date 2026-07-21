package com.cryptopulse.app.domain.models

/**
 * TradeSetupConfig holds the dynamic parameters for a strategy.
 *
 * Serialization Trade-off documentation:
 * We use Map<String, String> instead of Map<String, Any>.
 * While Map<String, Any> is convenient in the UI, serialization frameworks (like Gson/Moshi)
 * often struggle with type erasure on 'Any' (e.g., serializing 10 as 10.0).
 * By strictly storing all values as Strings, we guarantee stable JSON serialization.
 * The backend engine, which owns the absolute StrategySchema, can safely parse the strings 
 * back into Int/Double/Boolean based on its own source of truth.
 */
data class TradeSetupConfig(
    val strategyId: String,
    val symbol: String,
    val entryPrice: Double,
    val parameters: Map<String, String>
)
