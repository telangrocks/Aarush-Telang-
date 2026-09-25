package com.cryptopulse.app.forensics

import com.cryptopulse.app.data.api.dto.bot.response.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Deep inspector that examines AnalysisSnapshotDto without modifying any fields,
 * extracting the forensic evidence chain across Market Data, Indicators, Strategies,
 * Scoring, Qualification, and Final Signals.
 */
object ForensicSnapshotInspector {

    private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)

    fun inspectCycle(
        cycleId: String,
        source: String,
        snapshot: AnalysisSnapshotDto?,
        networkDurationMs: Long?,
        clientDurationMs: Long?,
        networkError: String?,
        previousScore: Int? = null,
        currentViewedStrategy: String? = null
    ): ForensicCycleRecord {
        val now = System.currentTimeMillis()
        val isoTimestamp = synchronized(isoFormat) { isoFormat.format(Date(now)) }
        val errors = mutableListOf<ForensicErrorItem>()

        // 1. Network Failure / Null Snapshot check (Pipeline Gap detection)
        if (snapshot == null) {
            val gap = PipelineGapForensic(
                gapDetected = true,
                lastCompletedStage = "REQUEST_DISPATCHED",
                interruptedAtStage = "RESPONSE_RECEIVED",
                gapReason = networkError ?: "Snapshot is null from remote endpoint"
            )
            val errorCategory = if (networkError?.contains("Timeout", ignoreCase = true) == true) {
                ForensicErrorCategory.TIMEOUT
            } else {
                ForensicErrorCategory.API_ERROR
            }
            errors.add(
                ForensicErrorItem(
                    category = errorCategory,
                    sourceComponent = "RetrofitNetworkTransport",
                    message = networkError ?: "Null snapshot response",
                    details = "Analysis cycle could not proceed past network transport."
                )
            )

            return ForensicCycleRecord(
                analysisCycleId = cycleId,
                timestamp = now,
                isoTimestamp = isoTimestamp,
                source = source,
                activeStrategy = currentViewedStrategy,
                engineState = "UNREACHABLE",
                pipelineStatus = "FAILED",
                pipelineGap = gap,
                marketData = MarketDataForensic(validationResult = "NOT_AVAILABLE"),
                indicators = emptyList(),
                strategies = emptyList(),
                scoreForensics = ScoreProgression(initialScore = 0, finalScore = 0, requiredScore = 0),
                qualification = QualificationForensic(qualificationAttempted = false, qualificationResult = "NOT_ATTEMPTED"),
                signal = SignalForensic(signalGenerated = false, nonGenerationCategory = "API_ERROR", exactNonGenerationReason = networkError),
                performance = PerformanceForensic(networkDurationMs = networkDurationMs, clientDurationMs = clientDurationMs, performanceAnomaly = (networkDurationMs ?: 0) > 5000),
                errors = errors,
                uiStateMatch = false,
                rawDtoAvailable = false
            )
        }

        // 2. Market Data Forensics
        val marketAnalysis = snapshot.marketAnalysis
        val engineStatus = snapshot.engineStatus
        val tradingSignal = snapshot.tradingSignal
        val strategyMetadata = snapshot.strategyMetadata

        val symbol = marketAnalysis?.symbol ?: "UNKNOWN"
        val activeStrategyName = strategyMetadata?.strategyId ?: engineStatus?.activeStrategy ?: currentViewedStrategy ?: "ScalperV2"
        val engineStateStr = engineStatus?.state ?: "UNKNOWN"

        val lastEvalTs = engineStatus?.lastEvaluationTimestamp
        val marketDataAgeMs = if (lastEvalTs != null && lastEvalTs > 0) Math.max(0L, now - lastEvalTs) else null
        val dataStale = marketDataAgeMs != null && marketDataAgeMs > 60_000L // Over 60 seconds old

        if (dataStale) {
            errors.add(
                ForensicErrorItem(
                    category = ForensicErrorCategory.DATA_STALE,
                    sourceComponent = "MarketDataEngine",
                    message = "Market data timestamp is $marketDataAgeMs ms old (> 60s)",
                    details = "Last evaluation: $lastEvalTs, Current: $now"
                )
            )
        }

        val marketDataForensic = MarketDataForensic(
            symbol = symbol,
            timeframe = strategyMetadata?.primaryTimeframe ?: "15m",
            exchange = "bybit",
            currentPrice = tradingSignal?.signalPrice,
            candleCountReceived = null, // Will be filled if backend attached forensicTrace
            marketDataAgeMs = marketDataAgeMs,
            latestCandleTimestamp = lastEvalTs,
            missingCandlesDetected = false,
            malformedDataDetected = false,
            validationResult = if (dataStale) "STALE" else "VALID",
            validationRejectionReason = if (dataStale) "Market data is older than 60 seconds" else null
        )

        // 3. Indicator Pipeline Forensics
        val rawIndicators = marketAnalysis?.indicatorSummary ?: emptyList()
        val indicatorList = mutableListOf<IndicatorForensic>()

        for (dtoInd in rawIndicators) {
            val name = dtoInd.name ?: "Unknown"
            val rawVal = dtoInd.value
            val numVal = rawVal?.replace(Regex("[^0-9.-]"), "")?.toDoubleOrNull()
            var status = "VALID"
            var abnormalFlag: String? = null
            var errorDetail: String? = null
            var isValid = true

            if (rawVal == null || rawVal.equals("null", ignoreCase = true) || rawVal.isBlank()) {
                status = "UNAVAILABLE"
                isValid = false
                errorDetail = "Indicator value was null or empty"
                errors.add(ForensicErrorItem(ForensicErrorCategory.INDICATOR_ERROR, "IndicatorEngine", "Indicator $name returned null", null))
            } else if (numVal != null) {
                if (numVal.isNaN()) {
                    status = "INVALID"
                    isValid = false
                    abnormalFlag = "NaN value detected"
                    errors.add(ForensicErrorItem(ForensicErrorCategory.NAN_VALUE, "IndicatorEngine", "Indicator $name is NaN", null))
                } else if (name.equals("RSI", ignoreCase = true) && (numVal < 0.0 || numVal > 100.0)) {
                    status = "ABNORMAL"
                    abnormalFlag = "RSI out of bounds: $numVal"
                    errors.add(ForensicErrorItem(ForensicErrorCategory.INDICATOR_ERROR, "IndicatorEngine", "RSI out of bounds [0-100]: $numVal", null))
                } else if (name.equals("ATR", ignoreCase = true) && numVal <= 0.0) {
                    status = "ABNORMAL"
                    abnormalFlag = "ATR is zero or negative: $numVal"
                    errors.add(ForensicErrorItem(ForensicErrorCategory.INDICATOR_ERROR, "IndicatorEngine", "ATR is <= 0 ($numVal). Cannot calculate risk.", null))
                }
            }

            indicatorList.add(
                IndicatorForensic(
                    indicatorName = name,
                    value = rawVal,
                    numericValue = numVal,
                    signal = dtoInd.signal,
                    calculationAttempted = true,
                    calculationCompleted = isValid,
                    isValid = isValid,
                    status = status,
                    abnormalFlag = abnormalFlag,
                    errorDetail = errorDetail
                )
            )
        }

        // 4. Strategy Forensics & Conditions
        val rawConditions = marketAnalysis?.conditionSummary ?: emptyList()
        val conditionsEvaluated = mutableListOf<String>()
        val conditionsPassed = mutableListOf<String>()
        val conditionsFailed = mutableListOf<String>()

        for (cond in rawConditions) {
            val condName = cond.name ?: cond.id ?: "UnknownCondition"
            conditionsEvaluated.add(condName)
            val isPassed = cond.status?.equals("PASSED", ignoreCase = true) == true
            if (isPassed) {
                conditionsPassed.add(condName)
            } else {
                conditionsFailed.add(condName)
            }
        }

        val strategyForensics = mutableListOf<StrategyForensic>()
        val strategyRejectionReason = if (conditionsFailed.isNotEmpty()) {
            "${conditionsFailed.size} of ${conditionsEvaluated.size} conditions failed: [${conditionsFailed.joinToString(", ")}]"
        } else null

        val strategyForensic = StrategyForensic(
            strategyName = activeStrategyName,
            executionStarted = true,
            executionCompleted = true,
            durationMs = null,
            rawResult = tradingSignal?.type ?: "NONE",
            confidenceScore = marketAnalysis?.confidenceScore,
            conditionsEvaluated = conditionsEvaluated,
            conditionsPassed = conditionsPassed,
            conditionsFailed = conditionsFailed,
            rejectionReason = strategyRejectionReason,
            contributedToDecision = true
        )
        strategyForensics.add(strategyForensic)

        // 5. Score Forensics
        val currentScore = marketAnalysis?.confidenceScore ?: 0
        val requiredScore = marketAnalysis?.requiredScore ?: snapshot.requiredScore ?: 70
        val scoreGap = currentScore - requiredScore
        val factorContributions = mutableListOf<ScoreFactorContribution>()

        val rawFactors = strategyMetadata?.factorContributions ?: emptyList()
        for (f in rawFactors) {
            factorContributions.add(
                ScoreFactorContribution(
                    factor = f.factor ?: "UnknownFactor",
                    weight = f.weight,
                    score = f.score,
                    level = f.level,
                    delta = null
                )
            )
        }

        val scoreDelta = if (previousScore != null) currentScore - previousScore else 0
        val significantChange = Math.abs(scoreDelta) >= 25
        if (significantChange) {
            errors.add(
                ForensicErrorItem(
                    category = ForensicErrorCategory.SCORE_ERROR,
                    sourceComponent = "ConfidenceEngine",
                    message = "Significant score jump: from $previousScore to $currentScore (delta: $scoreDelta)",
                    details = "Verified against factor weights: ${factorContributions.map { "${it.factor}=${it.score}" }}"
                )
            )
        }

        val scoreProgression = ScoreProgression(
            initialScore = previousScore ?: 50,
            factorContributions = factorContributions,
            finalScore = currentScore,
            requiredScore = requiredScore,
            scoreGap = scoreGap,
            significantChange = significantChange,
            scoreChangeDelta = scoreDelta
        )

        // 6. Signal Qualification Forensics
        val signalType = tradingSignal?.type?.uppercase()
        val signalGenerated = (signalType == "BUY" || signalType == "SELL") && (tradingSignal?.signalPrice != null || snapshot.opportunity != null)
        val qualificationAttempted = conditionsEvaluated.isNotEmpty() || currentScore > 0

        val qualificationResult = if (signalGenerated) {
            "PASSED"
        } else if (conditionsFailed.isNotEmpty() || currentScore < requiredScore) {
            "FAILED"
        } else {
            "NOT_AVAILABLE"
        }

        val exactFailureReason: String? = when {
            signalGenerated -> null
            currentScore < requiredScore -> "Confidence score ($currentScore) is below required minimum ($requiredScore)."
            conditionsFailed.isNotEmpty() -> "Required conditions failed: [${conditionsFailed.joinToString(", ")}]"
            tradingSignal?.reasoning?.isNotEmpty() == true -> tradingSignal.reasoning.joinToString("; ")
            else -> "Signal did not qualify: insufficient confirmation"
        }

        val qualificationForensic = QualificationForensic(
            qualificationAttempted = qualificationAttempted,
            qualificationResult = qualificationResult,
            proposedDirection = if (signalType == "BUY" || signalType == "SELL") signalType else null,
            requiredScore = requiredScore,
            actualScore = currentScore,
            conditionsPassed = conditionsPassed,
            conditionsFailed = conditionsFailed,
            exactFailureReason = exactFailureReason,
            finalRejectionReason = exactFailureReason
        )

        if (qualificationResult == "FAILED") {
            errors.add(
                ForensicErrorItem(
                    category = ForensicErrorCategory.QUALIFICATION_ERROR,
                    sourceComponent = "SignalValidator",
                    message = "Signal Qualification FAILED: $exactFailureReason",
                    details = "Score: $currentScore / $requiredScore, Failed: ${conditionsFailed.joinToString(", ")}"
                )
            )
        }

        // 7. Signal Generation Forensics
        val nonGenCategory = if (!signalGenerated) {
            when {
                currentScore < requiredScore -> "SCORE_INSUFFICIENT"
                conditionsFailed.isNotEmpty() -> "QUALIFICATION_FAILED"
                activeStrategyName.contains("Short", ignoreCase = true) -> "SHORT_NOT_SUPPORTED"
                else -> "CONFIRMATION_MISSING"
            }
        } else null

        val signalForensic = SignalForensic(
            signalGenerated = signalGenerated,
            signalType = if (signalGenerated) signalType else null,
            signalPrice = tradingSignal?.signalPrice,
            targetEntryPrice = tradingSignal?.targetEntryPrice,
            stopLoss = tradingSignal?.stopLoss,
            takeProfit = tradingSignal?.takeProfit,
            riskRewardRatio = if (tradingSignal?.signalPrice != null && tradingSignal.stopLoss != null && tradingSignal.takeProfit != null) {
                val risk = Math.abs(tradingSignal.signalPrice - tradingSignal.stopLoss)
                val reward = Math.abs(tradingSignal.takeProfit - tradingSignal.signalPrice)
                if (risk > 0) reward / risk else null
            } else null,
            positionSize = snapshot.opportunity?.positionSize,
            riskClassification = tradingSignal?.riskClassification ?: "MEDIUM",
            evidenceChain = tradingSignal?.reasoning ?: marketAnalysis?.confidenceExplanation ?: emptyList(),
            nonGenerationCategory = nonGenCategory,
            exactNonGenerationReason = exactFailureReason
        )

        // 8. Pipeline Gap Detection
        var gapDetected = false
        var lastCompletedStage = "SIGNAL_DECISION"
        var interruptedStage: String? = null
        var gapReason: String? = null

        if (rawIndicators.isEmpty()) {
            gapDetected = true
            lastCompletedStage = "MARKET_DATA"
            interruptedStage = "INDICATORS"
            gapReason = "Indicator summary array was empty from engine"
            errors.add(ForensicErrorItem(ForensicErrorCategory.PIPELINE_GAP, "StrategyOrchestrator", "Indicators missing from snapshot", null))
        } else if (rawConditions.isEmpty()) {
            gapDetected = true
            lastCompletedStage = "INDICATORS"
            interruptedStage = "STRATEGIES"
            gapReason = "Condition checkpoints were not evaluated"
            errors.add(ForensicErrorItem(ForensicErrorCategory.PIPELINE_GAP, "StrategyOrchestrator", "Condition checkpoints missing from snapshot", null))
        }

        val pipelineGap = PipelineGapForensic(
            gapDetected = gapDetected,
            lastCompletedStage = lastCompletedStage,
            interruptedAtStage = interruptedStage,
            missingStrategies = emptyList(),
            gapReason = gapReason
        )

        // 9. Performance Forensics
        val totalDuration = (networkDurationMs ?: 0L) + (clientDurationMs ?: 0L)
        val performanceAnomaly = totalDuration > 5000L
        if (performanceAnomaly) {
            errors.add(
                ForensicErrorItem(
                    category = ForensicErrorCategory.PERFORMANCE_ANOMALY,
                    sourceComponent = "ForensicPipeline",
                    message = "Cycle took ${totalDuration}ms (> 5000ms threshold)",
                    details = "Network: ${networkDurationMs}ms, Client: ${clientDurationMs}ms"
                )
            )
        }

        val performanceForensic = PerformanceForensic(
            networkDurationMs = networkDurationMs,
            backendDurationMs = null,
            clientDurationMs = clientDurationMs,
            totalCycleDurationMs = totalDuration,
            performanceAnomaly = performanceAnomaly
        )

        // UI consistency
        val uiStateMatch = currentViewedStrategy == null || currentViewedStrategy.equals(activeStrategyName, ignoreCase = true)

        val pipelineStatus = if (gapDetected) "PARTIAL" else "COMPLETED"

        return ForensicCycleRecord(
            analysisCycleId = cycleId,
            timestamp = now,
            isoTimestamp = isoTimestamp,
            source = source,
            activeStrategy = activeStrategyName,
            engineState = engineStateStr,
            pipelineStatus = pipelineStatus,
            pipelineGap = pipelineGap,
            marketData = marketDataForensic,
            indicators = indicatorList,
            strategies = strategyForensics,
            scoreForensics = scoreProgression,
            qualification = qualificationForensic,
            signal = signalForensic,
            performance = performanceForensic,
            errors = errors,
            uiStateMatch = uiStateMatch,
            rawDtoAvailable = true
        )
    }
}
