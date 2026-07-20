# Android Integration Contract v2.0

This document defines the strict boundary between the Android mobile application and the Crypto Pulse trading engine. 

Android remains a pure presentation layer and **must never implement trading intelligence.**

## Backend Responsibilities
The Backend (`trading-bot.ts` via `EngineAPIService`) is solely responsible for:
- Fetching market data.
- Computing indicators and market conditions.
- Determining confidence and risk.
- Executing trades.
- Transforming complex nested mathematical states into simple, flat DTOs.

## Android Responsibilities
The Android application is solely responsible for:
- Polling `/analysis-status`.
- Rendering textual and visual representations of the received DTOs.
- Translating predefined string enums (e.g., `PASSED`, `FAILED`, `BUY`) into UI themes, colors, and iconography.
- Managing local UI state (tabs, navigation).

## API Contract

The `/analysis-status` endpoint guarantees the delivery of the `AndroidIntegrationContract`:

```typescript
export interface AndroidIntegrationContract {
  engineStatus: EngineStatusDTO;
  marketAnalysis: MarketAnalysisDTO;
  tradingSignal: SignalDTO;
}
```

### 1. EngineStatusDTO
Communicates the health and lifecycle of the backend orchestrator.
```typescript
export interface EngineStatusDTO {
  state: string; // e.g., 'EVALUATING', 'WAITING', 'ERROR'
  activeStrategy: string; // e.g., 'ScalperV2'
  lastEvaluationTimestamp: number;
  nextEvaluationTime: number | null;
  health: 'OK' | 'DEGRADED' | 'ERROR';
}
```

### 2. MarketAnalysisDTO
Provides the distilled view of the market without exposing heavy statistical payload structures.
```typescript
export interface MarketAnalysisDTO {
  symbol: string;
  timeframeStatus: string;
  indicatorSummary: IndicatorSummary[];
  conditionSummary: ConditionSummary[];
  confidenceScore: number; // 0-100
  confidenceExplanation: string[];
}

export interface IndicatorSummary {
  name: string;
  value: string; // Pre-formatted string representation
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface ConditionSummary {
  id: string;
  name: string;
  currentValue: string;
  targetValue: string;
  status: 'PASSED' | 'FAILED' | 'WAITING';
}
```

### 3. SignalDTO
Provides the ultimate execution intent of the engine.
```typescript
export interface SignalDTO {
  type: 'BUY' | 'SELL' | 'HOLD';
  entryContext: string;
  stopLoss: number | null;
  takeProfit: number | null;
  riskClassification: string;
  reasoning: string[];
}
```

## Rendering Philosophy
- **Colors**: Android should map `PASSED` / `BULLISH` / `BUY` to Green, and `FAILED` / `BEARISH` / `SELL` to Red.
- **Formatting**: The backend should ideally format numbers to standard decimal lengths before shipping the string, though Android may apply locale-specific number formatting if desired.

## Future Compatibility Guidelines
- New fields added to the DTOs must be strictly optional or additive to prevent breaking older app versions.
- If a strategy requires completely different data representations, the UI should gracefully ignore unrecognized fields or the Backend should map them into the generic `ConditionSummary` structure.
