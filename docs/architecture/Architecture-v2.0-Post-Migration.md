# Architecture v2.0 (Post-Migration)

## 1. Overall System Architecture
The Crypto Pulse platform has been upgraded to a modular, strategy-driven engine pattern. The backend runs on Cloudflare Workers using a Durable Object (`TradingBot`) to handle long-running, stateful operations. The monolithic legacy architecture has been entirely replaced by a decoupled pipeline that isolates data ingestion, mathematical computation, condition evaluation, and execution.

## 2. Engine Responsibilities
- **Market Data Engine**: Interfaces with exchange adapters (`AdapterCandleProvider`) to fetch and normalize klines/candles into standard `MarketSnapshot` formats.
- **Indicator Engine**: A pure mathematical layer that transforms market data into statistical primitives (RSI, EMA, MACD, ATR). 
- **Condition Engine**: Translates raw indicator values into boolean market conditions (e.g., "Price Above EMA", "RSI Oversold").
- **Confidence Engine**: Scores the strength and reliability of the current market conditions (0-100 scale).
- **Risk Engine**: Calculates stop-loss, take-profit, position sizing, and maximum exposure limits.
- **Signal Engine**: Combines all outputs into a final `TradingSignal` (BUY, SELL, HOLD) accompanied by structured metadata.

## 3. Module Boundaries
- **Engines are stateless**: They receive snapshots/contexts and return computed results.
- **Strategies are plugins**: They define the specific rules and thresholds but do not implement indicator math or risk math themselves.
- **Durable Object is the Host**: `trading-bot.ts` handles networking, state persistence, alerts queuing, and UI contract translation, but holds zero mathematical or strategic logic.

## 4. Durable Object Lifecycle
- `/activate`: Instantiates the `StrategyOrchestrator`, loads the requested strategy plugin, wires the `MarketDataEngine`, and starts the `alarm()` loop.
- `alarm()`: Wakes up every 15 seconds, tells the `StrategyOrchestrator` to execute a cycle, processes the resulting signals, queues `TradeAlert`s, and caches `EngineAPIService` output for the UI.
- `/deactivate`: Halts the alarm and cleans up memory.
- `/analysis-status`: Serves the pre-computed `AndroidIntegrationContract` payload.

## 5. StrategyOrchestrator Responsibilities
The `StrategyOrchestrator` is the central nervous system. It:
1. Progresses the `EngineStateMachine` (INITIALIZING -> COLLECTING_DATA -> EVALUATING -> WAITING).
2. Triggers the Market Data Engine.
3. Builds the `StrategyContext` and freezes it.
4. Executes the active `IStrategy` plugins.
5. Captures the `EvaluationResult`.

## 6. Android Boundary
The Android application is treated purely as a "dumb terminal" presentation layer. It communicates with the backend via the `EngineAPIService`.
- Backend exposes simplified DTOs (e.g., `IndicatorSummary`).
- Android maps string statuses (e.g., `PASSED`, `FAILED`, `BUY`) to UI colors and typography.
- Android performs **zero** trading calculations, evaluation logic, or strategy intelligence.

## 7. Trade Execution Flow
1. **Signal Engine** yields a `TradingSignal` with `BUY` or `SELL`.
2. **DO `alarm()`** detects the signal and translates it into a standard `TradeAlert`.
3. The alert is pushed to the persistent `alerts` queue.
4. The execution subsystem inside the DO pulls pending alerts and forwards them to the underlying Exchange Adapter for live placement.

## 8. Extension Points
- **Exchange Adapters**: Can be added seamlessly by implementing `IExchangeAdapter`.
- **Indicators**: New math models can be added to `backend/src/engine/indicator/`.
- **Strategies**: New automated trading models can be added to `backend/src/engine/strategies/` implementing `IStrategy`.

## 9. Design Principles
- **Separation of Concerns**: Mathematical calculation, strategic evaluation, and trade execution are strictly isolated.
- **Immutability**: The `StrategyContext` passed to plugins is frozen (`Object.freeze`) to prevent side effects.
- **Fail-Safe Execution**: Erroneous data or strategy crashes fail gracefully without bringing down the DO lifecycle.

## 10. Non-functional Requirements
- **Performance**: The entire engine cycle must execute in < 50ms (excluding network IO).
- **Extensibility**: Adding a new indicator or condition must not require modifying existing strategies.
- **Testability**: Engines must be unit-testable in isolation using mocked snapshots.

## 11. Known Limitations
- Strategy execution is currently limited by the 15-second `alarm()` interval of Cloudflare Durable Objects.
- Backtesting is not yet natively supported in the Orchestrator pipeline.

## 12. Future Strategy Integration Guidelines
All future strategies (e.g., Momentum, Breakout) must be built as independent plugins implementing `IStrategy`. They must solely rely on the `StrategyContext` for market awareness and must not invoke the exchange adapters or fetch external data themselves.
