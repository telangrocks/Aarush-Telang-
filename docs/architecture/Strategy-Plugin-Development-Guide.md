# Strategy Plugin Development Guide

All new strategies developed for Crypto Pulse must follow this rigid plugin standard. 

A strategy plugin may consume engine outputs and provide strategy-specific rules, but **it must never modify or duplicate the core engine.**

## Required Interfaces

All strategies must implement the `IStrategy` interface:

```typescript
export interface IStrategy {
  readonly id: string;
  readonly name: string;
  readonly requiredTimeframes: string[];
  
  evaluate(context: Readonly<StrategyContext>): EvaluationResult;
}
```

## Folder Structure

Each strategy must be fully encapsulated in its own directory within the `strategies` folder.

```text
backend/src/engine/strategies/
└── [strategy-name]/
     ├── [StrategyName]Strategy.ts
     ├── [StrategyName]Config.ts
     ├── [StrategyName]Rules.ts
     └── index.ts
```

## Strategy Responsibilities
- Define which timeframes it requires.
- Define internal threshold constants (e.g., "RSI overbought = 70").
- Evaluate the frozen `StrategyContext`.
- Return an `EvaluationResult` containing a confidence score and structured metadata.

## Allowed Dependencies
- `StrategyContext`
- Pre-computed Engine Snapshots (`IndicatorSnapshot`, `ConditionResult`, `ConfidenceScore`, `RiskAssessment`).
- Local config and rule files within the strategy's directory.

## Forbidden Dependencies
- Strategies **MUST NOT** import or invoke any `ExchangeAdapter`.
- Strategies **MUST NOT** make HTTP network requests.
- Strategies **MUST NOT** attempt to calculate core indicators (EMA, RSI, etc.) manually.
- Strategies **MUST NOT** modify the `StrategyContext`. (It is enforced via `Object.freeze`, but any attempt is an architectural violation).

## Acceptance Checklist
Before a new Strategy Plugin can be merged, verify:
- [ ] Folder structure matches the standard.
- [ ] Implements `IStrategy` correctly.
- [ ] Returns `EvaluationResult` with properly populated `TradingSignal` metadata.
- [ ] Contains no manual mathematical calculations that belong in the Indicator/Condition engines.
- [ ] 100% Unit Test coverage using mocked `StrategyContext` objects.
- [ ] Integrated correctly into `trading-bot.ts` `/activate` strategy selection switch.
