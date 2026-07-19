# Architecture Decisions

This document tracks the major architectural decisions made for the Strategy Engine Framework (Version 1.0).

## 1. Separation of Concerns (Engines)
**Decision:** Break the monolithic `trading-bot.ts` into five independent engines: Data Engine, Math Engine (Indicators), Rules Engine (Conditions), Risk Engine, and Strategy Engine.
**Reason:** Allows strategies to be easily swapped and tested in isolation without duplicating data fetching or math logic.

## 2. Immutable StrategyContext
**Decision:** The `IStrategy.evaluate(ctx)` function receives an immutable `StrategyContext` containing a frozen snapshot of indicators and market data.
**Reason:** Guarantees deterministic execution. This makes historical backtesting mathematically identical to live execution, as the strategy cannot have hidden side effects.

## 3. Unidirectional Data Flow
**Decision:** Data flows strictly from the Exchange -> Ring Buffers -> Indicator Cache -> Strategy Evaluator -> Risk Engine -> Signal Engine. 
**Reason:** Eliminates race conditions and circular dependencies within the Durable Object.

## 4. Strategy Isolation (Plugins)
**Decision:** Strategies are defined as modular plugins implementing `IStrategy`.
**Reason:** Adding new strategies (e.g., VWAP Reversion) requires zero modifications to the core Orchestrator. 

## 5. Cloudflare / Backend Integration
**Decision:** Use `Float64Array` backed Circular Buffers instead of standard arrays for historical OHLCV data.
**Reason:** Preserves the 128MB memory limit of V8 Isolates and prevents Out Of Memory crashes during Garbage Collection.

## 6. Android Integration Boundaries
**Decision:** The UI must be completely dumb. The backend API `/live-status` will output the exact AST (Condition List) evaluated by the Rules Engine.
**Reason:** Prevents the frontend team from needing to understand strategy logic. If the backend adds a new indicator condition, the UI renders it automatically without requiring a mobile app update.
