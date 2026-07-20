# Execution Flow v2.0

The following diagrams and flows describe the runtime execution sequence of the Crypto Pulse backend post-migration to Architecture v2.0.

## Complete Runtime Flow

```text
Activate (/activate)
    ↓
Load User Configuration (Keys, Region, Environment)
    ↓
Load Strategy Plugin (e.g., ScalperV2Strategy)
    ↓
StrategyOrchestrator Initialized
    ↓
=== DO Heartbeat Begins (alarm()) ===
    ↓
StrategyOrchestrator.executeCycle()
    ↓
Market Data Engine (Fetches and standardizes exchange Klines)
    ↓
Indicator Engine (Computes RSI, EMA, MACD, etc.)
    ↓
Condition Engine (Evaluates trends, momentum, volume states)
    ↓
Confidence Engine (Calculates a 0-100 reliability score)
    ↓
Risk Engine (Determines position size, SL, TP)
    ↓
Strategy Evaluation (Plugin applies its specific rules)
    ↓
Signal Engine (Composes the TradingSignal)
    ↓
EngineAPIService (Transforms EngineState into DTOs)
    ↓
Durable Object Storage (Saves newAnalysis state)
    ↓
Trade Alert Generation (If signal == BUY/SELL)
    ↓
Execution Engine (Places order via Exchange Adapter)
```

## Core Lifecycles

### 1. `activate()` Lifecycle
- Receives user intent to start the bot.
- Parses configurations (target coin, position sizing, selected strategy).
- Instantiates the `StrategyOrchestrator`.
- Wires the appropriate `MarketDataEngine` using the user's saved Exchange credentials.
- Injects the active Strategy (e.g. `ScalperV2Strategy`).
- Kicks off the first alarm loop.

### 2. `alarm()` Lifecycle
- The Cloudflare Durable Object alarm wakes the bot every ~15 seconds.
- It delegates immediately to the `StrategyOrchestrator`.
- The `Orchestrator` runs the engine pipeline completely in memory.
- The resulting `EvaluationResult` is intercepted by the `EngineAPIService`.
- Formatted `AndroidIntegrationContract` DTOs are saved to DO storage under `newAnalysis`.
- If the result contains a high-confidence trade signal, it is converted to a `TradeAlert`.
- Pending alerts are processed by the DO's internal execution routines.

### 3. `/analysis-status` Request Flow
- The Android client periodically polls this endpoint.
- The DO retrieves the `newAnalysis` object populated during the last `alarm()`.
- The DO serves the payload.
- No calculations are performed during the HTTP request to ensure low latency.

### 4. Trade Execution Flow
- Internal DO logic detects a pending `TradeAlert`.
- It validates the user's `Safe Mode` and `GLOBAL_TRADING_HALT` settings.
- It attempts an atomic placement of the market/limit order using the `ExchangeAdapter`.
- It registers the trade in the D1 `trade_positions` table for persistent tracking.
