/**
 * RootCauseEngine.ts
 *
 * Deterministic, evidence-based diagnostic rule engine for CryptoPulse Incidents.
 * Strictly free of paid third-party AI APIs.
 *
 * Features:
 * - Separates confirmed facts from diagnostic hypotheses.
 * - Categorizes confidence (HIGH, MEDIUM, LOW).
 * - Identifies relevant source files, functions, and next investigation steps.
 * - Generates copyable Google Antigravity prompts with strict preservation rules.
 */

import { MonitoringEvent } from './MonitoringEvent';

export interface RootCauseDiagnosis {
  incidentId: string;
  whatHappened: string;
  whenHappened: string;
  affectedComponent: string;
  affectedUser: string;
  affectedBot: string;
  exactError: string;
  likelyRootCause: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  alternativeExplanations: string[];
  relevantFiles: string[];
  recommendedSteps: string[];
  resolutionStatus: string;
  antigravityPrompt: string;
}

interface DiagnosticRule {
  id: string;
  name: string;
  matches: (event: MonitoringEvent) => boolean;
  diagnose: (event: MonitoringEvent) => {
    whatHappened: string;
    likelyRootCause: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    alternatives: string[];
    relevantFiles: string[];
    steps: string[];
  };
}

const RULES: DiagnosticRule[] = [
  {
    id: 'INSUFFICIENT_BALANCE',
    name: 'Insufficient Exchange Balance / Margin',
    matches: (e) =>
      e.errorCode === 'INSUFFICIENT_BALANCE' ||
      e.errorCode === '10001' ||
      e.message.toLowerCase().includes('insufficient balance') ||
      e.message.toLowerCase().includes('not enough margin'),
    diagnose: (e) => ({
      whatHappened: `Order rejected due to insufficient available funds on ${e.evidence?.exchange || 'exchange'}.`,
      likelyRootCause: 'The user account does not hold sufficient free USDT to meet the required order notional value plus exchange fee buffers.',
      confidence: 'HIGH',
      alternatives: [
        'Funds are locked in active open limit orders on the exchange outside CryptoPulse.',
        'Exchange wallet transfer has not settled into the Unified Trading Account.'
      ],
      relevantFiles: [
        'backend/src/utils/balance.ts',
        'backend/src/trading-bot.ts',
        'backend/src/infrastructure/safety/validators/AccountPositionValidators.ts'
      ],
      steps: [
        'Query the live exchange account balance for the user.',
        'Verify if existing limit orders on Bybit hold margin in escrow.',
        'Advise user to deposit additional USDT or lower bot position size in setup.'
      ]
    })
  },
  {
    id: 'SAFETY_GATE_IN_FLIGHT_INTENT',
    name: 'Safety Gate Suppression: In-Flight Intent Exists',
    matches: (e) =>
      e.eventType === 'FINAL_DISPATCH_GATE' &&
      (e.evidence?.gate === 'IN_FLIGHT_INTENT' || e.message.includes('IN_FLIGHT_INTENT')),
    diagnose: (e) => ({
      whatHappened: `Trade alert for ${e.evidence?.symbol || 'symbol'} was suppressed because an existing order intent is in-flight.`,
      likelyRootCause: 'An existing order intent was dispatched to the exchange and has not yet transitioned to a terminal status (FILLED, CANCELLED, or REJECTED) in Durable Object state.',
      confidence: 'HIGH',
      alternatives: [
        'Exchange response latency is temporarily elevated, delaying order fill confirmation.',
        'Network interruption during order placement caused a timeout before acknowledgment was received.'
      ],
      relevantFiles: [
        'backend/src/engine/safety/FinalDispatchSafetyGate.ts',
        'backend/src/trading-bot.ts',
        'backend/src/engine/wal/WalTypes.ts'
      ],
      steps: [
        'Check the activeIntents map in the TradingBot Durable Object state.',
        'Verify Bybit open orders for the symbol to see if the clientOrderId matches the active intent.',
        'Wait for the reconciliation loop to sync order status.'
      ]
    })
  },
  {
    id: 'SAFETY_GATE_OPEN_POSITION',
    name: 'Safety Gate Suppression: Existing Open Position',
    matches: (e) =>
      e.eventType === 'FINAL_DISPATCH_GATE' &&
      (e.evidence?.gate === 'EXISTING_OPEN_POSITION' || e.message.includes('EXISTING_OPEN_POSITION')),
    diagnose: (e) => ({
      whatHappened: `Trade signal suppressed because an open position is already active for ${e.evidence?.symbol || 'symbol'}.`,
      likelyRootCause: 'The Level-1 safety gate prevents duplicate or pyramid entries for the same instrument while an existing position is open.',
      confidence: 'HIGH',
      alternatives: [
        'Position was closed manually on the exchange and the bot has not yet reconciled the closure.'
      ],
      relevantFiles: [
        'backend/src/engine/safety/FinalDispatchSafetyGate.ts',
        'backend/src/trading-bot.ts'
      ],
      steps: [
        'Inspect trade_positions table for active positions belonging to this user.',
        'Verify if the existing position is tracking its SL/TP orders correctly.'
      ]
    })
  },
  {
    id: 'SAFETY_GATE_RISK_REJECTED',
    name: 'Safety Gate Suppression: Risk Threshold Exceeded',
    matches: (e) =>
      e.eventType === 'FINAL_DISPATCH_GATE' &&
      (e.evidence?.gate === 'RISK_REJECTED' || e.evidence?.gate === 'MISSING_POSITION_SIZE'),
    diagnose: (e) => ({
      whatHappened: `Candidate trade rejected by RiskEngine or TradingPolicyEngine.`,
      likelyRootCause: 'The trade candidate exceeded allowable volatility thresholds, max drawdown boundaries, or failed the position sizing calculation.',
      confidence: 'HIGH',
      alternatives: [
        'Account balance is below minimum tradeable notional ($5.00 USDT).',
        'Market regime arbitrator classified market conditions as adverse.'
      ],
      relevantFiles: [
        'backend/src/infrastructure/safety/TradingPolicyEngine.ts',
        'backend/src/engine/scanner/ExecutionEligibilityGate.ts',
        'backend/src/engine/regime/MarketRegimeEngine.ts'
      ],
      steps: [
        'Review the ATR and volatility score for the symbol during the evaluation cycle.',
        'Check user risk preferences and max position size configuration in D1.'
      ]
    })
  },
  {
    id: 'RECONCILIATION_MISMATCH',
    name: 'Position Reconciliation Mismatch',
    matches: (e) =>
      e.eventType === 'RECONCILIATION_MISMATCH' ||
      e.lifecycleStage === 'WAL_RECONCILIATION' ||
      e.message.toLowerCase().includes('reconciliation mismatch'),
    diagnose: (e) => ({
      whatHappened: `Divergence detected between internal bot position state and live exchange positions.`,
      likelyRootCause: 'The exchange position size or side does not match the Durable Object activePositions store (e.g. manual trade executed on exchange or unexpected partial fill).',
      confidence: 'HIGH',
      alternatives: [
        'Stop-loss or Take-profit triggered on exchange, but websocket disconnect delayed notification.',
        'Position was liquidated by exchange risk engine.'
      ],
      relevantFiles: [
        'backend/src/engine/reconciliation/ReconciliationEngine.ts',
        'backend/src/trading-bot.ts'
      ],
      steps: [
        'Query exchange positions and trade execution history for the symbol.',
        'Verify whether position was closed on Bybit while bot was offline.',
        'Check reconciliationRetries count; if >= 3, position is quarantined.'
      ]
    })
  },
  {
    id: 'EXCHANGE_GEOBLOCK',
    name: 'Exchange Geo-blocking / CloudFront 403',
    matches: (e) =>
      e.errorCode === 'GEOBLOCK_403' ||
      e.message.includes('CloudFront 403') ||
      (e.message.toLowerCase().includes('blocked') && e.message.toLowerCase().includes('bybit')),
    diagnose: (e) => ({
      whatHappened: `Exchange rejected API request due to jurisdiction/IP restrictions.`,
      likelyRootCause: 'Outbound request was routed through a Cloudflare edge data center located in a restricted territory (such as the US).',
      confidence: 'HIGH',
      alternatives: [
        'Bybit CloudFront updated WAF rules blocking the specific Cloudflare IP range.'
      ],
      relevantFiles: [
        'backend/wrangler.toml',
        'backend/src/handlers/exchange.ts'
      ],
      steps: [
        'Verify backend/wrangler.toml has [placement] region = "aws:eu-central-1" (Frankfurt EU).',
        'Verify Worker is deployed to production with placement enabled.',
        'Confirm Bybit testnet/mainnet endpoint URL.'
      ]
    })
  },
  {
    id: 'RATE_LIMIT_EXCEEDED',
    name: 'Exchange Rate Limit Breached (HTTP 429)',
    matches: (e) =>
      e.errorCode === '429' ||
      e.errorCode === 'RATE_LIMIT_EXCEEDED' ||
      e.message.includes('429') ||
      e.message.toLowerCase().includes('too many requests'),
    diagnose: (e) => ({
      whatHappened: `Exchange responded with HTTP 429 Too Many Requests.`,
      likelyRootCause: 'Request frequency to exchange public or private endpoints exceeded the rate limit threshold within the sliding time window.',
      confidence: 'HIGH',
      alternatives: [
        'Multiple concurrent bots on the same API key made simultaneous balance or order requests.'
      ],
      relevantFiles: [
        'backend/src/infrastructure/exchange/pacing.ts',
        'backend/src/infrastructure/market-data/PublicMarketDataCoordinator.ts',
        'backend/src/infrastructure/cache/SingleFlightCoalescer.ts'
      ],
      steps: [
        'Check PublicMarketDataCoordinator cache hit-rate and single-flight coalescing stats.',
        'Review ExchangeRequestScheduler minRequestSpacingMs.',
        'Ensure private API calls are paced per API key.'
      ]
    })
  },
  {
    id: 'CANDLE_VALIDATION_FAILED',
    name: 'Market Data / Candle Validation Failure',
    matches: (e) =>
      e.eventType === 'CANDLE_VALIDATION_FAILED' ||
      e.lifecycleStage === 'CANDLE_VALIDATION' ||
      e.message.toLowerCase().includes('candle gap') ||
      e.message.toLowerCase().includes('stale candle'),
    diagnose: (e) => ({
      whatHappened: `OHLCV candle series failed freshness or continuity validation.`,
      likelyRootCause: 'The candle series received from the exchange contains missing intervals, timestamps older than allowable tolerance, or zero volume gaps.',
      confidence: 'MEDIUM',
      alternatives: [
        'Exchange market data feed experienced micro-outage.',
        'Low-liquidity pair had no trades during the timeframe interval.'
      ],
      relevantFiles: [
        'backend/src/infrastructure/exchange/CandleValidator.ts',
        'backend/src/engine/market-data/MarketDataEngine.ts',
        'backend/src/engine/market-data/AdapterCandleProvider.ts'
      ],
      steps: [
        'Inspect the raw candle timestamps in the error evidence payload.',
        'Verify if the symbol is actively trading on Bybit.',
        'Check if other timeframes (e.g. 15m, 1h) are updating normally.'
      ]
    })
  },
  {
    id: 'CIRCUIT_BREAKER_ACTIVE',
    name: 'Circuit Breaker / Global Trading Halt',
    matches: (e) =>
      e.eventType === 'CIRCUIT_BREAKER' ||
      e.lifecycleStage === 'CIRCUIT_BREAKER' ||
      e.message.includes('GLOBAL_TRADING_HALT') ||
      e.message.includes('UNPROTECTED_EXPOSURE'),
    diagnose: (e) => ({
      whatHappened: `Execution halted by system circuit breaker or emergency tripwire.`,
      likelyRootCause: 'GLOBAL_TRADING_HALT is enabled in environment or an unprotected exposure lock was triggered due to SL/TP order placement failure.',
      confidence: 'HIGH',
      alternatives: [
        'Operator activated manual emergency halt.'
      ],
      relevantFiles: [
        'backend/src/trading-bot.ts',
        'backend/src/engine/safety/FinalDispatchSafetyGate.ts'
      ],
      steps: [
        'Inspect the lock:unprotectedExposure key in TradingBot storage.',
        'Confirm if open position exists without exchange stop-loss order.',
        'Review GLOBAL_TRADING_HALT in backend vars.'
      ]
    })
  },
  {
    id: 'EXCHANGE_INVALID_CREDENTIALS',
    name: 'Invalid or Revoked Exchange Credentials',
    matches: (e) =>
      e.errorCode === '10003' ||
      e.errorCode === '10004' ||
      e.message.toLowerCase().includes('invalid api key') ||
      e.message.toLowerCase().includes('sign error') ||
      e.message.toLowerCase().includes('ip mismatch'),
    diagnose: (e) => ({
      whatHappened: `Exchange rejected authenticated request due to invalid credentials or signature.`,
      likelyRootCause: 'The API key or secret saved in D1 is incorrect, expired, or does not match the IP restriction configured on Bybit.',
      confidence: 'HIGH',
      alternatives: [
        'Decryption key mismatch in backend environment.',
        'API key permissions lack Contract/Derivatives trading privileges.'
      ],
      relevantFiles: [
        'backend/src/crypto.ts',
        'backend/src/handlers/exchange.ts',
        'backend/src/infrastructure/security/SecurityPolicy.ts'
      ],
      steps: [
        'Validate credentials using the validate-exchange endpoint.',
        'Verify API key permissions on Bybit (Trade, Read required).',
        'Ensure IP whitelist on Bybit is disabled or includes Cloudflare edge egress.'
      ]
    })
  }
];

export class RootCauseEngine {
  /**
   * Deterministically diagnoses an incident event based on evidence and rule patterns.
   */
  public static diagnoseIncident(event: MonitoringEvent): RootCauseDiagnosis {
    const matchedRule = RULES.find((r) => r.matches(event));

    const timestampStr = new Date(event.timestamp).toUTCString();
    const affectedUser = event.userId || 'GLOBAL / ANONYMOUS';
    const affectedBot = event.botId || (event.userId ? `bot_${event.userId.slice(0, 8)}` : 'N/A');

    if (matchedRule) {
      const diagnosis = matchedRule.diagnose(event);
      const antigravityPrompt = this.generateAntigravityPrompt({
        incidentId: event.id,
        severity: event.severity,
        source: event.source,
        component: event.component,
        lifecycleStage: event.lifecycleStage || 'N/A',
        errorCode: event.errorCode || 'NONE',
        timestamp: timestampStr,
        evidence: event.evidence ? JSON.stringify(event.evidence, null, 2) : 'No extra evidence provided',
        likelyRootCause: diagnosis.likelyRootCause,
        relevantFiles: diagnosis.relevantFiles,
        confidence: diagnosis.confidence
      });

      return {
        incidentId: event.id,
        whatHappened: diagnosis.whatHappened,
        whenHappened: timestampStr,
        affectedComponent: event.component,
        affectedUser,
        affectedBot,
        exactError: event.message,
        likelyRootCause: diagnosis.likelyRootCause,
        confidence: diagnosis.confidence,
        alternativeExplanations: diagnosis.alternatives,
        relevantFiles: diagnosis.relevantFiles,
        recommendedSteps: diagnosis.steps,
        resolutionStatus: event.status,
        antigravityPrompt
      };
    }

    // Default Fallback when no deterministic rule matches
    const fallbackRootCause = 'Root cause unknown — more evidence required.';
    const fallbackFiles = ['backend/src/index.ts', 'backend/src/trading-bot.ts'];
    const fallbackSteps = [
      'Inspect related server logs around timestamp ' + timestampStr,
      'Check if the error is reproducible in local tests',
      'Collect additional evidence from the bot runtime status'
    ];

    const antigravityPrompt = this.generateAntigravityPrompt({
      incidentId: event.id,
      severity: event.severity,
      source: event.source,
      component: event.component,
      lifecycleStage: event.lifecycleStage || 'N/A',
      errorCode: event.errorCode || 'NONE',
      timestamp: timestampStr,
      evidence: event.evidence ? JSON.stringify(event.evidence, null, 2) : 'None',
      likelyRootCause: fallbackRootCause,
      relevantFiles: fallbackFiles,
      confidence: 'LOW'
    });

    return {
      incidentId: event.id,
      whatHappened: `Unclassified ${event.severity} in ${event.component}: ${event.message}`,
      whenHappened: timestampStr,
      affectedComponent: event.component,
      affectedUser,
      affectedBot,
      exactError: event.message,
      likelyRootCause: fallbackRootCause,
      confidence: 'LOW',
      alternativeExplanations: [
        'Transient edge networking failure or timeout.',
        'Unhandled edge condition in upstream exchange response payload.'
      ],
      relevantFiles: fallbackFiles,
      recommendedSteps: fallbackSteps,
      resolutionStatus: event.status,
      antigravityPrompt
    };
  }

  /**
   * Generates a copyable Google Antigravity investigation prompt.
   * STRICT DIRECTIVE: Directs the agent to investigate first and preserve trading logic.
   */
  public static generateAntigravityPrompt(params: {
    incidentId: string;
    severity: string;
    source: string;
    component: string;
    lifecycleStage: string;
    errorCode: string;
    timestamp: string;
    evidence: string;
    likelyRootCause: string;
    relevantFiles: string[];
    confidence: string;
  }): string {
    return [
      `### CRYPTOPULSE INCIDENT INVESTIGATION PROMPT`,
      ``,
      `**Incident ID:** \`${params.incidentId}\``,
      `**Severity:** \`${params.severity}\``,
      `**Source:** \`${params.source}\` | **Component:** \`${params.component}\``,
      `**Lifecycle Stage:** \`${params.lifecycleStage}\``,
      `**Error Code:** \`${params.errorCode}\``,
      `**Observed At (UTC):** ${params.timestamp}`,
      `**Confidence:** ${params.confidence}`,
      ``,
      `#### Evidence & Context`,
      `\`\`\`json`,
      `${params.evidence}`,
      `\`\`\``,
      ``,
      `#### Initial Diagnosis`,
      `**Likely Root Cause:** ${params.likelyRootCause}`,
      `**Candidate Files:**`,
      params.relevantFiles.map((f) => `- \`${f}\``).join('\n'),
      ``,
      `---`,
      `#### Instructions for Antigravity AI Assistant`,
      `1. **Investigate First:** Read the candidate source files and verify this diagnosis against existing logs and Durable Object / D1 state.`,
      `2. **Preserve Trading Logic:** Do NOT modify trading strategies, indicators, risk calculations, or safety thresholds unless explicitly directed.`,
      `3. **Propose Minimal Fix:** If a bug or regression is confirmed, formulate the most conservative, targeted fix possible.`,
      `4. **Verify Locally:** Run unit and integration tests from \`backend/\` to verify zero regression before proposing any deployment.`,
      `5. Report your findings with exact line references and verified evidence.`
    ].join('\n');
  }
}
