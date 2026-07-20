# Architecture v2.1 — Plugin Architecture

## Overview
Architecture v2.1 introduces a fully uncoupled plugin system for trading strategies. It acts as an extension of Architecture v2.0 without altering the frozen Core Engine (IndicatorEngine, ConditionEngine, ConfidenceEngine, RiskEngine, SignalEngine, MarketDataEngine).

## Strategy Registry & Discovery
- **StrategyRegistry**: A singleton registry that maintains initialized strategy instances and their declarative metadata (Manifests). It ensures deterministic loading and strict deduplication.
- **StrategyManifest**: A strongly-typed contract that each strategy must expose. It acts as the definitive source for Android and presentation layers to understand strategy capabilities without importing business logic.
- **Discovery Endpoint**: Exposed at `GET /strategies` on the Durable Object, providing versioned StrategyManifests dynamically to the frontend.

## Plugin Implementation (IStrategy)
Every strategy is required to implement the `IStrategy` interface:
1. `evaluate(context: Readonly<StrategyContext>): EvaluationResult` - Evaluates the frozen context.
2. `readonly manifest: StrategyManifest` - Exposes the static metadata properties of the strategy.
