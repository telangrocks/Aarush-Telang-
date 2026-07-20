# Android API Integration Contract

This document outlines the API contract between the Strategy Engine (Backend) and the Android mobile client.

## Philosophy

The Android UI acts as a pure renderer of backend intelligence. 
Android **MUST NOT**:
- Evaluate indicator data
- Determine if a trend is bullish or bearish
- Execute trading logic
- Compute risk or position sizes

All intelligence is serialized into the `AndroidIntegrationContract` payload.

## Data Structures

The main payload the Android application will receive contains three sections:

### 1. Engine Status (`EngineStatusDTO`)
Describes the overall state of the backend Strategy Engine.

- **state**: The current FSM state (e.g., `EVALUATING`, `WAITING`, `INITIALIZING`).
- **activeStrategy**: The name/ID of the current strategy being run (e.g., `ScalperV2`).
- **lastEvaluationTimestamp**: Unix timestamp of the last engine cycle.
- **nextEvaluationTime**: When the engine expects to run its next cycle (useful for UI countdowns).
- **health**: Overall health (`OK`, `DEGRADED`, `ERROR`).

### 2. Market Analysis (`MarketAnalysisDTO`)
Describes the math and rules evaluated by the engine.

- **symbol**: The trading pair (e.g., `BTC/USDT`).
- **timeframeStatus**: Current sync status of the OHLCV ring buffers.
- **indicatorSummary**: High-level text summaries of the indicators (e.g., `RSI(14) = 45.0` -> `NEUTRAL`). The UI should map `signal` to colors (e.g., BULLISH=Green, BEARISH=Red).
- **conditionSummary**: The exact AST rules the engine just evaluated. The UI renders this exactly as it receives it. If the backend adds a new condition, the UI naturally renders it without an update.
- **confidenceScore**: A 0-100 gauge of the overall opportunity.
- **confidenceExplanation**: Plain text explaining *why* the score is what it is.

### 3. Trading Signal (`SignalDTO`)
Describes the exact boundaries of a prospective or active trade.

- **type**: `BUY`, `SELL`, or `HOLD`.
- **entryContext**: Explanation of the entry trigger.
- **stopLoss**: Computed stop loss price.
- **takeProfit**: Computed take profit price.
- **riskClassification**: `LOW`, `MEDIUM`, `HIGH`, `EXTREME`.
- **reasoning**: A bulleted list of rationale for the user to review.
