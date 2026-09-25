import { MarketOpportunity, ScannerConfig, DEFAULT_SCANNER_CONFIG } from './ScannerTypes';

export interface RankerOutput {
  readonly allQualifiedOpportunities: MarketOpportunity[];
  readonly topOpportunities: MarketOpportunity[];     // Sliced to displayLimit for UI presentation
  readonly invalidatedCount: number;
  readonly degradedCount: number;
}

export interface IncumbentRankState {
  readonly opportunityId: string;
  readonly symbol: string;
  readonly rank: number;
  readonly score: number;
  readonly direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  readonly assignedAt: number;
}

export function getOpportunityIdentity(opp: MarketOpportunity): string {
  if (opp.opportunityId && opp.opportunityId.includes(':')) {
    return opp.opportunityId;
  }
  const strat = opp.strategyCompatibility?.[0]?.strategyId || 'Default';
  return `${opp.symbol}:${strat}:${opp.dominantDirection}`;
}

/**
 * OpportunityRanker ranks all discovered market opportunities.
 * 
 * CORE PRINCIPLES:
 * 1. Quality over Quota: Ranks all genuine qualified opportunities. Does not force artificial quotas.
 * 2. Stable Opportunity Identity: Identity = Instrument + Strategy ID + Direction.
 *    Multiple distinct opportunities per instrument (e.g. ETH/USDT:ScalperV2:LONG vs ETH/USDT:Momentum:SHORT)
 *    are preserved with independent ranks, while identical records are deduplicated.
 * 3. Strict Invalidation Precedence:
 *    Structural Invalidation > Data Degradation > Directional Shift > Normal Score Fluctuation
 * 4. Hysteresis Buffer: Prevents UI rank jitter on minor score noise without keeping invalid opportunities alive.
 */
export class OpportunityRanker {
  private incumbentRanks = new Map<string, IncumbentRankState>();

  constructor(private readonly config: ScannerConfig = DEFAULT_SCANNER_CONFIG) {}

  public rank(candidates: MarketOpportunity[], currentTime: number = Date.now()): RankerOutput {
    const qualified: MarketOpportunity[] = [];
    let invalidatedCount = 0;
    let degradedCount = 0;

    // Deduplicate identical opportunity identities in the input batch
    const seenIds = new Set<string>();
    const deduplicatedCandidates: MarketOpportunity[] = [];
    for (const opp of candidates) {
      const oppId = getOpportunityIdentity(opp);
      if (seenIds.has(oppId)) continue;
      seenIds.add(oppId);
      deduplicatedCandidates.push(opp);
    }

    // 1. Process Precedence 1 & 2: Structural Invalidation & Data Degradation
    for (const opp of deduplicatedCandidates) {
      const oppId = getOpportunityIdentity(opp);

      if (opp.state === 'INVALIDATED' || opp.invalidationReason) {
        invalidatedCount++;
        this.incumbentRanks.delete(oppId);
        continue;
      }

      if (opp.state === 'DATA_DEGRADED' || opp.marketQuality.grade === 'DEGRADED' || opp.marketQuality.grade === 'REJECTED') {
        degradedCount++;
        this.incumbentRanks.delete(oppId);
        continue;
      }

      // Check directional consistency for this specific opportunity
      const incumbent = this.incumbentRanks.get(oppId);
      if (incumbent && incumbent.direction !== opp.dominantDirection) {
        // Precedence 3: Directional shift clears incumbent lock immediately
        this.incumbentRanks.delete(oppId);
      }

      qualified.push(opp);
    }

    // 2. Sort candidates using Hysteresis & Anti-Churn Buffer
    // A challenger must beat an incumbent by >= hysteresisScoreBuffer to displace it
    qualified.sort((a, b) => {
      const aId = getOpportunityIdentity(a);
      const bId = getOpportunityIdentity(b);
      const aIncumbent = this.incumbentRanks.get(aId);
      const bIncumbent = this.incumbentRanks.get(bId);

      const aIsLocked = aIncumbent && (currentTime - aIncumbent.assignedAt < this.config.rankLockDurationMs);
      const bIsLocked = bIncumbent && (currentTime - bIncumbent.assignedAt < this.config.rankLockDurationMs);

      // Both locked: preserve incumbent relative ordering if score difference is within hysteresis
      if (aIsLocked && bIsLocked) {
        const scoreDiff = a.opportunityScore - b.opportunityScore;
        if (Math.abs(scoreDiff) < this.config.hysteresisScoreBuffer) {
          return aIncumbent.rank - bIncumbent.rank;
        }
      }

      // 'a' is locked, 'b' is challenger: 'b' needs buffer to beat 'a'
      if (aIsLocked && !bIsLocked) {
        if (b.opportunityScore > a.opportunityScore + this.config.hysteresisScoreBuffer) {
          return -1; // challenger b clearly beats a
        }
        return 1; // incumbent a defends position
      }

      // 'b' is locked, 'a' is challenger: 'a' needs buffer to beat 'b'
      if (!aIsLocked && bIsLocked) {
        if (a.opportunityScore > b.opportunityScore + this.config.hysteresisScoreBuffer) {
          return -1; // challenger a clearly beats b
        }
        return 1; // incumbent b defends position
      }

      // Standard descending sort by opportunityScore
      if (b.opportunityScore !== a.opportunityScore) {
        return b.opportunityScore - a.opportunityScore;
      }

      // Secondary tiebreaker: net edge ratio
      const aEdge = Math.max(a.longEvaluation.netEdgeRatio, a.shortEvaluation.netEdgeRatio);
      const bEdge = Math.max(b.longEvaluation.netEdgeRatio, b.shortEvaluation.netEdgeRatio);
      return bEdge - aEdge;
    });

    // 3. Assign Ranks and Update Incumbents
    const updatedIncumbents = new Map<string, IncumbentRankState>();
    const rankedOpportunities: MarketOpportunity[] = qualified.map((item, index) => {
      const currentRank = index + 1;
      const oppId = getOpportunityIdentity(item);
      const prevIncumbent = this.incumbentRanks.get(oppId);
      const previousRank = prevIncumbent ? prevIncumbent.rank : null;

      updatedIncumbents.set(oppId, {
        opportunityId: oppId,
        symbol: item.symbol,
        rank: currentRank,
        score: item.opportunityScore,
        direction: item.dominantDirection,
        assignedAt: prevIncumbent && prevIncumbent.rank === currentRank ? prevIncumbent.assignedAt : currentTime,
      });

      return {
        ...item,
        currentRank,
        previousRank,
      };
    });

    this.incumbentRanks = updatedIncumbents;

    // Discovery set retains ALL qualified candidates
    // Top opportunities provides display slice for UI
    const topOpportunities = rankedOpportunities.slice(0, this.config.displayLimit);

    return {
      allQualifiedOpportunities: rankedOpportunities,
      topOpportunities,
      invalidatedCount,
      degradedCount,
    };
  }

  public getIncumbent(identityOrSymbol: string): IncumbentRankState | undefined {
    return this.incumbentRanks.get(identityOrSymbol) || 
      Array.from(this.incumbentRanks.values()).find(i => i.symbol === identityOrSymbol);
  }

  public clear(): void {
    this.incumbentRanks.clear();
  }
}
