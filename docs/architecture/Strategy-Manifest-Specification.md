# Strategy Manifest Specification

## Overview
Every strategy plugin registered in the system MUST expose a `readonly manifest: StrategyManifest` property complying with this specification. The manifest serves as the public presentation layer and discovery contract for external clients (e.g., Android app).

## Schema
```typescript
interface StrategyManifest {
  id: string;                      // Unique identifier (e.g., 'ScalperV2')
  displayName: string;             // Human-readable name
  description: string;             // Strategy purpose and behavior
  version: string;                 // Semver string (e.g., '1.0.0')
  category: string;                // Classification (e.g., 'Scalping')
  riskProfile: string;             // Risk categorization (e.g., 'High')
  supportedMarkets: string[];      // Markets supported (e.g., ['CRYPTO'])
  supportedTimeframes: Timeframe[];// Compatible data timeframes
  minimumCandles: number;          // Minimum historical candles needed to evaluate
  defaultConfiguration: Record<string, any>; // Default initialization configuration
  supportsLong: boolean;           // True if BUY signals are generated
  supportsShort: boolean;          // True if SHORT signals are generated
  supportsPaperTrading: boolean;   // True if paper trading is supported
  supportsLiveTrading: boolean;    // True if live trading is supported
  status: 'ACTIVE' | 'EXPERIMENTAL' | 'DEPRECATED'; 
  author: string;                  // Creator/Maintainer identity
}
```

## Discovery
The manifests are accessible via `GET /strategies` which returns `StrategyDiscoveryResponseDTO`.
