import {
  CanonicalTradeSignal,
  NormalizedObservation,
  OpportunityRecord,
} from './types/SignalLifecycleTypes';
import { SignalDataMapper } from './mapping/SignalDataMapper';
import { generateOpportunityId } from './identity/OpportunityIdentity';
import { ModeAAuthorityPolicy } from './policies/ModeAAuthorityPolicy';
import { ITimeframeCorrelationPolicy } from './policies/ITimeframeCorrelationPolicy';
import { DefaultTimeframeCorrelationPolicy } from './policies/DefaultTimeframeCorrelationPolicy';

export interface SignalLifecycleManagerOptions {
  correlationPolicy?: ITimeframeCorrelationPolicy;
  opportunityTtlMs?: number;
}

const DEFAULT_OPPORTUNITY_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * SignalLifecycleManager
 *
 * Coordinates the entire signal management lifecycle:
 * - Ingestion & strict fail-closed mapping
 * - Mode A strategy authority & fallback selection
 * - Deterministic observation & opportunity identity
 * - Cross-timeframe correlation & consolidation
 * - Lifecycle state tracking (FORMING, ACTIVE, SUPERSEDED, EXPIRED)
 * - Zero post-execution position monitoring (strictly opportunity detection & alert lifecycle)
 */
export class SignalLifecycleManager {
  private opportunities: Map<string, OpportunityRecord> = new Map();
  private activeOpportunitiesBySymbol: Map<string, string> = new Map();
  private correlationPolicy: ITimeframeCorrelationPolicy;
  private opportunityTtlMs: number;

  constructor(options?: SignalLifecycleManagerOptions) {
    this.correlationPolicy = options?.correlationPolicy ?? new DefaultTimeframeCorrelationPolicy();
    this.opportunityTtlMs = options?.opportunityTtlMs ?? DEFAULT_OPPORTUNITY_TTL_MS;
  }

  /**
   * Processes a batch of strategy evaluations across symbols and timeframes.
   *
   * @param evaluations Array of StrategyEvaluationResult objects from StrategyOrchestrator
   * @param committedStrategyId Active bot strategy committed by user, if any
   * @returns Array of canonical trade signals ready for dispatch / comparison
   */
  public processEvaluations(
    evaluations: any[],
    committedStrategyId: string | null | undefined
  ): CanonicalTradeSignal[] {
    if (!evaluations || !Array.isArray(evaluations) || evaluations.length === 0) {
      this.pruneExpiredOpportunities();
      return [];
    }

    // Group evaluations by symbol
    const evaluationsBySymbol = new Map<string, any[]>();
    for (const evalResult of evaluations) {
      if (!evalResult) continue;
      const symbol =
        evalResult.symbol ??
        evalResult.metadata?.symbol ??
        evalResult.metadata?.signal?.symbol ??
        evalResult.metadata?.forensicTrace?.symbol;
      const normSymbol = (symbol || '').trim().toUpperCase();
      if (!normSymbol) continue;

      if (!evaluationsBySymbol.has(normSymbol)) {
        evaluationsBySymbol.set(normSymbol, []);
      }
      evaluationsBySymbol.get(normSymbol)!.push(evalResult);
    }

    const canonicalSignals: CanonicalTradeSignal[] = [];

    for (const [symbol, symbolEvals] of evaluationsBySymbol.entries()) {
      // 1. Ingest & normalize observations via fail-closed mapper
      const observations: NormalizedObservation[] = [];
      for (const rawEval of symbolEvals) {
        const obs = SignalDataMapper.mapEvaluationToObservation(rawEval, symbol);
        if (obs) {
          observations.push(obs);
        }
      }

      if (observations.length === 0) {
        continue;
      }

      // 2. Select primary observation (Mode A authority or highest-confidence fallback)
      const selection = ModeAAuthorityPolicy.selectPrimaryObservation(observations, committedStrategyId);
      if (!selection) {
        continue;
      }

      const primary = selection.primary;

      // 3. Partition supporting vs conflicting observations
      const otherObservations = observations.filter(o => o.obsId !== primary.obsId);
      const supporting: NormalizedObservation[] = [];
      const conflicting: NormalizedObservation[] = [];

      for (const obs of otherObservations) {
        if (obs.direction === primary.direction) {
          supporting.push(obs);
        } else {
          conflicting.push(obs);
        }
      }

      // 4. Calculate cross-timeframe correlation score
      const correlationScore = this.correlationPolicy.calculateCorrelation(primary, otherObservations);

      // 5. Lifecycle Opportunity resolution
      const currentOppId = this.activeOpportunitiesBySymbol.get(symbol);
      const existingOpp = currentOppId ? this.opportunities.get(currentOppId) : undefined;
      const now = Date.now();

      let opportunity: OpportunityRecord;

      if (existingOpp && existingOpp.state === 'ACTIVE') {
        if (existingOpp.direction !== primary.direction) {
          // Genuine directional reversal: supersede old opportunity
          const newOppId = generateOpportunityId(symbol, primary.direction, primary.closedCandleTimestamp);
          existingOpp.state = 'SUPERSEDED';
          existingOpp.supersededBy = newOppId;
          existingOpp.lastUpdatedTimestamp = now;

          opportunity = {
            oppId: newOppId,
            symbol,
            direction: primary.direction,
            firstBarClosedTimestamp: primary.closedCandleTimestamp,
            lastUpdatedTimestamp: now,
            state: 'ACTIVE',
            primaryObservation: primary,
            supportingObservations: supporting,
            conflictingObservations: conflicting,
            alertSentAt: now,
          };
          this.opportunities.set(newOppId, opportunity);
          this.activeOpportunitiesBySymbol.set(symbol, newOppId);
        } else {
          // Same direction: check TTL
          if (now - existingOpp.lastUpdatedTimestamp > this.opportunityTtlMs) {
            existingOpp.state = 'EXPIRED';
            const newOppId = generateOpportunityId(symbol, primary.direction, primary.closedCandleTimestamp);
            opportunity = {
              oppId: newOppId,
              symbol,
              direction: primary.direction,
              firstBarClosedTimestamp: primary.closedCandleTimestamp,
              lastUpdatedTimestamp: now,
              state: 'ACTIVE',
              primaryObservation: primary,
              supportingObservations: supporting,
              conflictingObservations: conflicting,
              alertSentAt: now,
            };
            this.opportunities.set(newOppId, opportunity);
            this.activeOpportunitiesBySymbol.set(symbol, newOppId);
          } else {
            // Update existing opportunity cleanly (cross-timeframe consolidation)
            existingOpp.lastUpdatedTimestamp = now;
            existingOpp.supportingObservations = supporting;
            existingOpp.conflictingObservations = conflicting;

            // Upgrade primary observation if new one has higher confidence or newer candle
            if (
              primary.confidence > existingOpp.primaryObservation.confidence ||
              primary.closedCandleTimestamp > existingOpp.primaryObservation.closedCandleTimestamp
            ) {
              existingOpp.primaryObservation = primary;
            }
            opportunity = existingOpp;
          }
        }
      } else {
        // No existing active opportunity
        const oppId = generateOpportunityId(symbol, primary.direction, primary.closedCandleTimestamp);
        opportunity = {
          oppId,
          symbol,
          direction: primary.direction,
          firstBarClosedTimestamp: primary.closedCandleTimestamp,
          lastUpdatedTimestamp: now,
          state: 'ACTIVE',
          primaryObservation: primary,
          supportingObservations: supporting,
          conflictingObservations: conflicting,
          alertSentAt: now,
        };
        this.opportunities.set(oppId, opportunity);
        this.activeOpportunitiesBySymbol.set(symbol, oppId);
      }

      // 6. Form Canonical Trade Signal
      const canonicalSignal: CanonicalTradeSignal = {
        oppId: opportunity.oppId,
        symbol: opportunity.symbol,
        action: opportunity.direction,
        entryPrice: primary.entryPrice,
        confidence: primary.confidence,
        timeframe: primary.timeframe,
        strategy: primary.strategyId,
        timestamp: now,
        candleTimestamp: primary.closedCandleTimestamp,
        indicators: primary.indicators,
        regime: primary.regime || 'UNKNOWN',
        correlationScore,
        mode: selection.mode,
      };

      canonicalSignals.push(canonicalSignal);
    }

    // 7. Expire old opportunities beyond TTL
    this.pruneExpiredOpportunities();

    return canonicalSignals;
  }

  /**
   * Retrieves an opportunity record by ID.
   */
  public getOpportunity(oppId: string): OpportunityRecord | undefined {
    return this.opportunities.get(oppId);
  }

  /**
   * Retrieves the current active opportunity for a symbol.
   */
  public getActiveOpportunityForSymbol(symbol: string): OpportunityRecord | undefined {
    const oppId = this.activeOpportunitiesBySymbol.get(symbol.trim().toUpperCase());
    if (!oppId) return undefined;
    const opp = this.opportunities.get(oppId);
    if (opp && opp.state === 'ACTIVE') {
      return opp;
    }
    return undefined;
  }

  /**
   * Returns all stored opportunities.
   */
  public getAllOpportunities(): OpportunityRecord[] {
    return Array.from(this.opportunities.values());
  }

  /**
   * Exports full state for Durable Object persistence.
   */
  public getState(): Record<string, OpportunityRecord> {
    const state: Record<string, OpportunityRecord> = {};
    for (const [id, opp] of this.opportunities.entries()) {
      state[id] = opp;
    }
    return state;
  }

  /**
   * Restores state from persisted Durable Object storage.
   */
  public restoreState(state: Record<string, OpportunityRecord> | null | undefined): void {
    if (!state || typeof state !== 'object') return;
    this.opportunities.clear();
    this.activeOpportunitiesBySymbol.clear();

    for (const [id, opp] of Object.entries(state)) {
      if (opp && opp.oppId) {
        this.opportunities.set(opp.oppId, opp);
        if (opp.state === 'ACTIVE') {
          this.activeOpportunitiesBySymbol.set(opp.symbol, opp.oppId);
        }
      }
    }
  }

  /**
   * Clears in-memory state.
   */
  public clearState(): void {
    this.opportunities.clear();
    this.activeOpportunitiesBySymbol.clear();
  }

  /**
   * Prunes opportunities that have exceeded the TTL.
   */
  private pruneExpiredOpportunities(): void {
    const now = Date.now();
    for (const [id, opp] of this.opportunities.entries()) {
      if (opp.state === 'ACTIVE' && now - opp.lastUpdatedTimestamp > this.opportunityTtlMs) {
        opp.state = 'EXPIRED';
        const activeId = this.activeOpportunitiesBySymbol.get(opp.symbol);
        if (activeId === id) {
          this.activeOpportunitiesBySymbol.delete(opp.symbol);
        }
      }
    }
  }
}
