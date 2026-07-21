package com.cryptopulse.app.data.repository

import com.cryptopulse.app.domain.models.*
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.delay

@Singleton
class StrategyRepositoryImpl @Inject constructor() : StrategyRepository {
    
    // Mock data for Phase 1
    private val mockStrategies = listOf(
        Strategy(
            id = "scalping_v1",
            name = "Scalping",
            description = "Quick in-and-out trades capturing small price movements.",
            category = StrategyCategory.SCALPING,
            riskLevel = RiskLevel.HIGH,
            schemaVersion = 1,
            requiredParameters = listOf(
                StrategyParameterSchema(
                    key = "leverage",
                    displayName = "Leverage",
                    type = ParameterType.INT,
                    defaultValue = "10",
                    isRequired = true,
                    minValue = 1.0,
                    maxValue = 50.0
                ),
                StrategyParameterSchema(
                    key = "stop_loss_pct",
                    displayName = "Stop Loss (%)",
                    type = ParameterType.DOUBLE,
                    defaultValue = "1.0",
                    isRequired = true,
                    minValue = 0.1,
                    maxValue = 5.0
                ),
                StrategyParameterSchema(
                    key = "use_trailing_sl",
                    displayName = "Use Trailing SL",
                    type = ParameterType.BOOLEAN,
                    defaultValue = "true",
                    isRequired = true
                )
            )
        ),
        Strategy(
            id = "swing_v1",
            name = "Swing Trading",
            description = "Capture multi-day trends with wider targets.",
            category = StrategyCategory.SWING,
            riskLevel = RiskLevel.MEDIUM,
            schemaVersion = 1,
            requiredParameters = listOf(
                StrategyParameterSchema(
                    key = "leverage",
                    displayName = "Leverage",
                    type = ParameterType.INT,
                    defaultValue = "3",
                    isRequired = true,
                    minValue = 1.0,
                    maxValue = 10.0
                ),
                StrategyParameterSchema(
                    key = "target_count",
                    displayName = "Number of Targets",
                    type = ParameterType.ENUM,
                    defaultValue = "2",
                    isRequired = true,
                    options = listOf("1", "2", "3")
                )
            )
        )
    )

    override suspend fun getStrategies(): Result<List<Strategy>> {
        delay(300) // Simulate network delay
        return Result.success(mockStrategies)
    }

    override suspend fun getStrategyById(id: String): Result<Strategy?> {
        delay(150)
        val strategy = mockStrategies.find { it.id == id }
        return Result.success(strategy)
    }
}
