import { IExchangeProvider } from '../../exchanges/IExchangeProvider';
import { ICandleProvider } from '../../infrastructure/exchange/types';
import {
  ScannerConfig,
  DEFAULT_SCANNER_CONFIG,
  MarketOpportunity,
  MarketQualityAssessment,
  OpportunityState,
  DirectionalEvaluation,
  OpportunityFactors,
  ScannerTelemetryRecord,
  TimeframeAnalysisSnapshot,
} from './ScannerTypes';
import { MultiTimeframeCandleStore, ScannerTimeframe } from './MultiTimeframeCandleStore';
import { TradingCostEngine } from './TradingCostEngine';
import { StrategyCompatibilityEvaluator } from './StrategyCompatibilityEvaluator';
import { OpportunityRanker, RankerOutput } from './OpportunityRanker';
import { IndicatorEngine } from '../indicator/IndicatorEngine';
import { MarketRegimeEngine, MarketRegime } from '../regime/MarketRegimeEngine';
import { ExecutionEligibilityGate } from './ExecutionEligibilityGate';
import { MetricsEngine } from '../../telemetry/MetricsEngine';
import { StructuredLogger } from '../../infrastructure/telemetry/Telemetry';

const STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI', 'USDP',
  'USDE', 'PYUSD', 'FRAX', 'USDD', 'GUSD', 'USDJ', 'EURT',
  'USDY', 'LUSD', 'CRVUSD'
]);

const LEVERAGED_TOKEN_REGEX = /.*(2L|3L|4L|5L|10L|2S|3S|4S|5S|10S|UP|DOWN|BULL|BEAR)(USDT|USDC|DAI)?$/i;

function extractBaseAsset(symbol: string): string {
  if (!symbol) return '';
  const clean = symbol.trim().toUpperCase();
  if (clean.includes('/')) return clean.split('/')[0];
  if (clean.includes('-')) return clean.split('-')[0];
  if (clean.includes('_')) return clean.split('_')[0];
  for (const q of ['USDT', 'USDC', 'BUSD', 'USD', 'BTC', 'ETH', 'EUR']) {
    if (clean.endsWith(q) && clean.length > q.length) {
      return clean.slice(0, clean.length - q.length);
    }
  }
  return clean;
}

function isExcludedAsset(symbolStr: string): boolean {
  const clean = String(symbolStr || '').trim().toUpperCase();
  const base = extractBaseAsset(clean);
  if (STABLECOINS.has(clean) || STABLECOINS.has(base)) return true;
  if (LEVERAGED_TOKEN_REGEX.test(clean) || LEVERAGED_TOKEN_REGEX.test(base)) return true;
  return false;
}

export interface ScannerScanResult {
  readonly timestamp: number;
  readonly executionDurationMs: number;
  readonly universeSize: number;
  readonly eligibleCount: number;
  readonly qualityCount: number;
  readonly screenedCount: number;
  readonly allQualifiedOpportunities: MarketOpportunity[];
  readonly topOpportunities: MarketOpportunity[];
  readonly telemetry: ScannerTelemetryRecord;
}

/**
 * MarketOpportunityScanner: Live multi-pair, multi-timeframe market opportunity discovery engine.
 * 
 * INVARIANT: This class is purely for discovery, filtering, analysis, and ranking.
 * It has ZERO execution logic, ZERO order dispatch, and ZERO position sizing capabilities.
 */
export class MarketOpportunityScanner {
  private readonly candleStore: MultiTimeframeCandleStore;
  private readonly costEngine: TradingCostEngine;
  private readonly compatibilityEvaluator: StrategyCompatibilityEvaluator;
  private readonly ranker: OpportunityRanker;
  private readonly indicatorEngine: IndicatorEngine;
  private readonly logger = new StructuredLogger();
  private universeCache: { timestamp: number; markets: any[] } | null = null;
  private readonly UNIVERSE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly provider: IExchangeProvider & ICandleProvider,
    private readonly config: ScannerConfig = DEFAULT_SCANNER_CONFIG,
    candleStore?: MultiTimeframeCandleStore,
    costEngine?: TradingCostEngine,
    compatibilityEvaluator?: StrategyCompatibilityEvaluator,
    ranker?: OpportunityRanker
  ) {
    this.candleStore = candleStore ?? new MultiTimeframeCandleStore(this.provider, 70);
    this.costEngine = costEngine ?? new TradingCostEngine(this.config);
    this.compatibilityEvaluator = compatibilityEvaluator ?? new StrategyCompatibilityEvaluator();
    this.ranker = ranker ?? new OpportunityRanker(this.config);

    this.indicatorEngine = new IndicatorEngine({
      rsiPeriods: [14],
      smaPeriods: [20],
      emaPeriods: [9, 20, 21, 50, 200],
      macdParams: [{ fast: 12, slow: 26, signal: 9 }],
      atrPeriods: [14],
      volumeAveragePeriod: 20,
    });
  }

  /**
   * Executes a complete discovery cycle across the entire eligible market universe.
   */
  public async scan(options?: { markets?: any[]; tickers?: any[]; tradeAmountUsdt?: number }): Promise<ScannerScanResult> {
    const startTime = performance.now();
    const cycleTimestamp = Date.now();
    const cycleId = crypto.randomUUID();

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 0: Universe Ingestion (Complete Bybit Linear Universe)
    // ─────────────────────────────────────────────────────────────────────────
    let markets: any[] = [];
    if (options?.markets && options.markets.length > 0) {
      markets = options.markets;
    } else if (this.universeCache && (cycleTimestamp - this.universeCache.timestamp < this.UNIVERSE_CACHE_TTL_MS)) {
      markets = this.universeCache.markets;
    } else {
      try {
        markets = await this.provider.fetchMarkets();
        this.universeCache = { timestamp: cycleTimestamp, markets };
      } catch (err: any) {
        this.logger.error('[MarketOpportunityScanner] Failed to fetch instruments universe:', err);
        markets = this.universeCache?.markets || [];
      }
    }

    const universeSize = markets.length;

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: Hard Eligibility & Liquidity Filtering
    // ─────────────────────────────────────────────────────────────────────────
    // Deduplicate at the instrument level and ensure primary perpetual universe
    const seenSymbols = new Set<string>();
    const eligibleMarkets: any[] = [];

    for (const m of markets) {
      if (m.active === false) continue;
      if (m.category && m.category !== 'linear') continue;
      // Filter out non-perpetual linear contracts (e.g. dated delivery futures)
      if (m.contractType && m.contractType !== 'LinearPerpetual') continue;
      const quote = String(m.quote || '').toUpperCase();
      if (quote !== 'USDT') continue;
      const sym = m.symbol || m.id || '';
      if (isExcludedAsset(sym)) continue;

      // Ensure distinct instruments so duplicate inputs cannot consume MTF candle slots
      const canonicalSymbol = m.symbol || m.id;
      if (seenSymbols.has(canonicalSymbol)) continue;
      seenSymbols.add(canonicalSymbol);

      eligibleMarkets.push(m);
    }

    const eligibleSymbols = eligibleMarkets.map((m: any) => m.symbol);
    const eligibleCount = eligibleSymbols.length;

    // Bulk Ticker Retrieval: 1 HTTP call covers entire active universe
    let tickerMap = new Map<string, any>();
    if (options?.tickers && options.tickers.length > 0) {
      for (const t of options.tickers) {
        if (t.symbol) tickerMap.set(t.symbol, t);
        if (t.pairName) tickerMap.set(t.pairName, t);
        if (t.id) tickerMap.set(t.id, t);
      }
    } else {
      try {
        const tickers = await this.provider.fetchTickers(eligibleSymbols);
        for (const t of tickers) {
          if (t.symbol) tickerMap.set(t.symbol, t);
          if ((t as any).id) tickerMap.set((t as any).id, t);
        }
      } catch (err: any) {
        this.logger.error('[MarketOpportunityScanner] Failed bulk fetchTickers:', err);
        throw err;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: Broad Market Quality Screening
    // ─────────────────────────────────────────────────────────────────────────
    const qualityCandidates: Array<{ market: any; ticker: any; quality: MarketQualityAssessment }> = [];

    for (const m of eligibleMarkets) {
      const t = tickerMap.get(m.symbol) || tickerMap.get(m.id) || tickerMap.get(m.base);
      if (!t) continue;

      const px = typeof t.last?.toNumber === 'function' ? t.last.toNumber() : Number(t.last ?? t.price ?? 0);
      if (px <= 0 || isNaN(px)) continue;

      const bid = typeof t.bid?.toNumber === 'function' ? t.bid.toNumber() : Number(t.bid ?? px);
      const ask = typeof t.ask?.toNumber === 'function' ? t.ask.toNumber() : Number(t.ask ?? px);
      const turnover = typeof t.quoteVolume?.toNumber === 'function' ? t.quoteVolume.toNumber() : Number(t.quoteVolume ?? t.quoteVolume24h ?? 0);
      const high = typeof t.high?.toNumber === 'function' ? t.high.toNumber() : Number(t.high ?? t.highPrice24h ?? px);
      const low = typeof t.low?.toNumber === 'function' ? t.low.toNumber() : Number(t.low ?? t.lowPrice24h ?? px);

      const spreadPercent = px > 0 ? ((ask - bid) / px) * 100 : 0;
      const rangePercent = px > 0 ? ((high - low) / px) * 100 : 0;

      const rejectionReasons: string[] = [];

      const qtyStep = m.precision?.amount || 0.00001;
      const minOrderQty = typeof m.limits?.amount?.min?.toNumber === 'function' ? m.limits.amount.min.toNumber() : Number(m.limits?.amount?.min || 0);
      const minNotionalUsdt = typeof m.limits?.cost?.min?.toNumber === 'function' ? m.limits.cost.min.toNumber() : Number(m.limits?.cost?.min || 5);

      if (turnover < this.config.minTurnover24hUsdt) {
        rejectionReasons.push(`Turnover $${turnover.toFixed(0)} < $${this.config.minTurnover24hUsdt}`);
      }
      if (spreadPercent > this.config.maxSpreadPercent) {
        rejectionReasons.push(`Spread ${spreadPercent.toFixed(3)}% > ${this.config.maxSpreadPercent}%`);
      }
      if (rangePercent < this.config.minRange24hPercent) {
        rejectionReasons.push(`24h range ${rangePercent.toFixed(2)}% < ${this.config.minRange24hPercent}%`);
      }

      const isPrime = rejectionReasons.length === 0 && spreadPercent <= 0.05 && turnover >= 5_000_000;
      const isAcceptable = rejectionReasons.length === 0;

      const grade = isPrime ? 'PRIME' : isAcceptable ? 'ACCEPTABLE' : 'REJECTED';

      const pctVal = typeof t.percentage?.toNumber === 'function' 
        ? t.percentage.toNumber() 
        : (typeof t.percentage === 'number' && Number.isFinite(t.percentage)
          ? t.percentage 
          : (typeof t.priceChangePercent24h === 'number' && Number.isFinite(t.priceChangePercent24h)
            ? t.priceChangePercent24h
            : (t.price24hPcnt !== undefined && Number.isFinite(parseFloat(t.price24hPcnt))
              ? parseFloat(t.price24hPcnt) * 100
              : (t.info?.priceChangePercent !== undefined && Number.isFinite(parseFloat(t.info.priceChangePercent))
                ? parseFloat(t.info.priceChangePercent)
                : (t.info?.price24hPcnt !== undefined && Number.isFinite(parseFloat(t.info.price24hPcnt))
                  ? parseFloat(t.info.price24hPcnt) * 100
                  : 0)))));
      const cleanPriceChangePercent24h = Number.isFinite(pctVal) ? pctVal : 0;

      const quality: MarketQualityAssessment = {
        symbol: m.symbol,
        grade,
        turnover24hUsdt: turnover,
        bidAskSpreadPercent: spreadPercent,
        orderBookDepthScore: Math.min(100, Math.round((turnover / 10_000_000) * 100)),
        tickSize: m.precision?.price || 0.01,
        qtyStep,
        minOrderQty,
        minNotionalUsdt,
        isStablecoinOrLeveraged: false,
        priceChangePercent24h: cleanPriceChangePercent24h,
        dataSanity: { isFresh: true, gapCount: 0, hasStaleCandles: false },
        rejectionReasons,
      };

      if (grade === 'PRIME' || grade === 'ACCEPTABLE') {
        qualityCandidates.push({ market: m, ticker: t, quality });
      }
    }

    const qualityCount = qualityCandidates.length;

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3 & 4: Staged Multi-Timeframe Retrieval & Technical Analysis
    // ─────────────────────────────────────────────────────────────────────────
    // Prioritize top liquid quality candidates for deep multi-timeframe candle evaluation
    qualityCandidates.sort((a, b) => b.quality.turnover24hUsdt - a.quality.turnover24hUsdt);
    const deepCandidates = qualityCandidates.slice(0, 25);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2.5: Budget & Execution Constraint Gate (Post-Top-25)
    // Reduce Top 25 quality-ranked candidates down to 0 <= N <= 25 affordable candidates
    // ─────────────────────────────────────────────────────────────────────────
    const affordableCandidates = (options?.tradeAmountUsdt !== undefined && options.tradeAmountUsdt > 0)
      ? deepCandidates.filter(({ market, ticker, quality }) => {
          const px = typeof ticker.last?.toNumber === 'function' ? ticker.last.toNumber() : Number(ticker.last ?? ticker.price ?? 0);
          const eligibility = ExecutionEligibilityGate.evaluate({
            tradeAmountUsdt: options.tradeAmountUsdt!,
            currentPrice: px,
            qtyStep: quality.qtyStep || 0.00001,
            minOrderQty: quality.minOrderQty,
            minNotional: quality.minNotionalUsdt,
          });
          return eligibility.isExecutable;
        })
      : deepCandidates;

    const BATCH_SIZE = 5;
    const evaluatedOpportunities: MarketOpportunity[] = [];

    for (let i = 0; i < affordableCandidates.length; i += BATCH_SIZE) {
      const batch = affordableCandidates.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async ({ market, ticker, quality }) => {
          const symbol = market.symbol;
          try {
            // Retrieve tiered candles across 4h, 1h, 15m, 5m (candle store respects TTLs)
            const mtfSnapshot = await this.candleStore.getMultiTimeframeSnapshot(symbol, ['4h', '1h', '15m', '5m']);
            if (mtfSnapshot.isFullyDegraded) {
              return null;
            }

            const candles1h = mtfSnapshot.timeframes['1h']?.candles || [];
            const candles15m = mtfSnapshot.timeframes['15m']?.candles || [];
            const candles5m = mtfSnapshot.timeframes['5m']?.candles || [];
            const candles4h = mtfSnapshot.timeframes['4h']?.candles || [];

            if (candles1h.length < 20 || candles15m.length < 20 || candles5m.length < 20) {
              return null;
            }

            // Indicator Evaluation on 1h (Regime & Macro Trend)
            const highs1h = candles1h.map(c => c.high);
            const lows1h = candles1h.map(c => c.low);
            const closes1h = candles1h.map(c => c.close);
            const closes15m = candles15m.map(c => c.close);
            const closes5m = candles5m.map(c => c.close);
            const volumes5m = candles5m.map(c => c.volume);

            const atr14_1h = this.calculateATRSimple(candles1h, 14);
            const adx14 = MarketRegimeEngine.calculateAdx(highs1h, lows1h, closes1h, 14);
            const emaSlope20 = MarketRegimeEngine.calculateEmaSlope(closes1h, 20);
            const regimeBase = MarketRegimeEngine.evaluate(highs1h, lows1h, closes1h, atr14_1h);

            const regime = {
              ...regimeBase,
              adx14,
              emaSlope20Percent: emaSlope20,
              atrExpansionRatio: regimeBase.score > 70 ? 1.25 : 1.0,
            };

            // Technical Indicators across timeframes
            const ema20_1h = this.calculateEMASimple(closes1h, 20);
            const ema50_1h = this.calculateEMASimple(closes1h, 50);
            const rsi14_1h = this.calculateRSISimple(closes1h, 14);

            const ema20_15m = this.calculateEMASimple(closes15m, 20);
            const ema50_15m = this.calculateEMASimple(closes15m, 50);
            const rsi14_15m = this.calculateRSISimple(closes15m, 14);

            const ema9_5m = this.calculateEMASimple(closes5m, 9);
            const ema21_5m = this.calculateEMASimple(closes5m, 21);
            const rsi14_5m = this.calculateRSISimple(closes5m, 14);
            const atr14_5m = this.calculateATRSimple(candles5m, 14);

            // Volume Surge on 5m
            const currentVol5m = volumes5m[volumes5m.length - 1] || 0;
            const avgVol5m = volumes5m.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 || 1;
            const volumeRatio5m = currentVol5m / avgVol5m;

            // ─────────────────────────────────────────────────────────────────
            // STAGE 5: Multi-Timeframe Alignment & Directional Evaluation
            // ─────────────────────────────────────────────────────────────────
            const is1hBull = ema20_1h > ema50_1h && rsi14_1h > 50;
            const is1hBear = ema20_1h < ema50_1h && rsi14_1h < 50;

            const is15mBull = ema20_15m > ema50_15m && rsi14_15m > 50;
            const is15mBear = ema20_15m < ema50_15m && rsi14_15m < 50;

            const is5mBull = ema9_5m > ema21_5m && rsi14_5m > 50;
            const is5mBear = ema9_5m < ema21_5m && rsi14_5m < 50;

            let mtfState: 'ALIGNED' | 'TRANSITIONAL' | 'CONFLICTING' = 'CONFLICTING';
            if ((is1hBull && is15mBull) || (is1hBear && is15mBear)) {
              mtfState = 'ALIGNED';
            } else if ((is1hBull && !is15mBear) || (is1hBear && !is15mBull)) {
              mtfState = 'TRANSITIONAL';
            }

            // Directional Evaluation (LONG)
            let mtfLongScore = (is1hBull ? 40 : 0) + (is15mBull ? 35 : 0) + (is5mBull ? 25 : 0);
            let momentumLongScore = Math.min(100, Math.max(0, (rsi14_5m - 45) * 4));
            let volumeScore = Math.min(100, Math.round((volumeRatio5m / 1.5) * 100));

            // Directional Evaluation (SHORT)
            let mtfShortScore = (is1hBear ? 40 : 0) + (is15mBear ? 35 : 0) + (is5mBear ? 25 : 0);
            let momentumShortScore = Math.min(100, Math.max(0, (55 - rsi14_5m) * 4));

            // ─────────────────────────────────────────────────────────────────
            // STAGE 6: Analytical Cost & Execution Feasibility
            // ─────────────────────────────────────────────────────────────────
            const px = typeof ticker.last?.toNumber === 'function' ? ticker.last.toNumber() : Number(ticker.last || 1);
            const bid = typeof ticker.bid?.toNumber === 'function' ? ticker.bid.toNumber() : px;
            const ask = typeof ticker.ask?.toNumber === 'function' ? ticker.ask.toNumber() : px;

            // Strategy-specific expected target: e.g. 2.0x 15m ATR expressed as %
            const atr14_15m = this.calculateATRSimple(candles15m, 14);
            const expectedTargetPercent = px > 0 ? (2.0 * atr14_15m / px) * 100 : 1.5;

            const costBreakdown = this.costEngine.evaluate({
              price: px,
              bid,
              ask,
              atr1m: atr14_5m / 2.2, // estimated 1m ATR from 5m ATR
              expectedTargetPercent,
              turnover1mUsdt: quality.turnover24hUsdt / 1440,
            });

            // ─────────────────────────────────────────────────────────────────
            // STAGE 7: Strategy Compatibility & Composite Opportunity Score
            // ─────────────────────────────────────────────────────────────────
            const longCompatibility = this.compatibilityEvaluator.evaluate(regime, 'LONG');
            const shortCompatibility = this.compatibilityEvaluator.evaluate(regime, 'SHORT');

            const dominantDirection = mtfLongScore >= mtfShortScore ? 'LONG' : 'SHORT';
            const primaryCompatibility = dominantDirection === 'LONG' ? longCompatibility : shortCompatibility;

            // Composite Opportunity Score (Weighted Hypotheses)
            const activeMtfScore = dominantDirection === 'LONG' ? mtfLongScore : mtfShortScore;
            const activeMomentumScore = dominantDirection === 'LONG' ? momentumLongScore : momentumShortScore;
            const regimeFitScore = Math.max(...primaryCompatibility.map(c => c.compatibilityScore), 0);

            const weights = this.config.weights;
            const rawOpportunityScore = Math.round(
              (activeMtfScore * weights.mtfAlignment / 100) +
              (regimeFitScore * weights.regimeAndStrategyFit / 100) +
              (activeMomentumScore * weights.momentumAndVolume / 100) +
              (costBreakdown.feasibilityScore * weights.costFeasibility / 100)
            );

            const opportunityScore = Math.min(100, Math.max(0, rawOpportunityScore));

            const reasons: string[] = [
              ...costBreakdown.reasons,
              mtfState === 'ALIGNED' ? `Strong MTF trend alignment (${dominantDirection}).` : `Transitional MTF setup.`,
              volumeRatio5m > 1.25 ? `5m volume surge (${volumeRatio5m.toFixed(2)}x 20MA).` : `Normal volume profile.`,
            ];
            const warnings: string[] = [...costBreakdown.warnings];

            // Opportunity State Gating & Data Degradation Detection
            const hasDegradedTimeframe = Object.values(mtfSnapshot.timeframes).some(tf => tf?.isDegraded);
            let state: OpportunityState = 'DISCOVERED';
            if (hasDegradedTimeframe) {
              state = 'DATA_DEGRADED';
            } else if (opportunityScore >= 75 && costBreakdown.isViable && mtfState === 'ALIGNED') {
              state = 'HIGH_CONVICTION';
            } else if (opportunityScore >= 60 && costBreakdown.isViable) {
              state = 'QUALIFIED';
            }

            const currentMarketQuality: MarketQualityAssessment = {
              ...quality,
              grade: hasDegradedTimeframe ? 'DEGRADED' : quality.grade,
              dataSanity: {
                isFresh: !hasDegradedTimeframe,
                gapCount: Object.values(mtfSnapshot.timeframes).reduce((acc, tf) => acc + (tf?.hasGaps ? 1 : 0), 0),
                hasStaleCandles: Object.values(mtfSnapshot.timeframes).some(tf => !tf?.isFresh),
              },
            };

            const rawFactors: OpportunityFactors = {
              mtfAlignmentScore: activeMtfScore,
              regimeScore: regime.score,
              momentumScore: activeMomentumScore,
              volumeRatio: volumeRatio5m,
              spreadPercent: costBreakdown.spreadPercent,
              estimatedSlippagePercent: costBreakdown.estimatedSlippagePercent,
              roundTripFeePercent: costBreakdown.roundTripFeePercent,
              totalFrictionPercent: costBreakdown.totalFrictionPercent,
              netEdgeRatio: costBreakdown.netEdgeRatio,
              adx14: regime.adx14,
              emaSlope20: regime.emaSlope20Percent,
              atrExpansionRatio: regime.atrExpansionRatio,
            };

            const longEvaluation: DirectionalEvaluation = {
              direction: 'LONG',
              rawScore: mtfLongScore,
              mtfAlignmentScore: mtfLongScore,
              momentumScore: momentumLongScore,
              volumeScore,
              netEdgeRatio: costBreakdown.netEdgeRatio,
              isViable: costBreakdown.isViable && mtfLongScore >= 50,
              reasons: [`Long MTF score: ${mtfLongScore}`],
              warnings: mtfLongScore < 50 ? ['Weak long alignment'] : [],
            };

            const shortEvaluation: DirectionalEvaluation = {
              direction: 'SHORT',
              rawScore: mtfShortScore,
              mtfAlignmentScore: mtfShortScore,
              momentumScore: momentumShortScore,
              volumeScore,
              netEdgeRatio: costBreakdown.netEdgeRatio,
              isViable: costBreakdown.isViable && mtfShortScore >= 50,
              reasons: [`Short MTF score: ${mtfShortScore}`],
              warnings: mtfShortScore < 50 ? ['Weak short alignment'] : [],
            };

            // Build Timeframe Snapshots
            const timeframes: MarketOpportunity['timeframes'] = {
              '1h': {
                timeframe: '1h',
                trend: is1hBull ? 'BULLISH' : is1hBear ? 'BEARISH' : 'NEUTRAL',
                momentum: rsi14_1h > 55 ? 'BULLISH' : rsi14_1h < 45 ? 'BEARISH' : 'NEUTRAL',
                closePrice: closes1h[closes1h.length - 1],
                ema20: ema20_1h,
                ema50: ema50_1h,
                rsi14: rsi14_1h,
                atr14: atr14_1h,
                candleTimestamp: candles1h[candles1h.length - 1]?.openTime || cycleTimestamp,
                isFresh: true,
              },
              '15m': {
                timeframe: '15m',
                trend: is15mBull ? 'BULLISH' : is15mBear ? 'BEARISH' : 'NEUTRAL',
                momentum: rsi14_15m > 55 ? 'BULLISH' : rsi14_15m < 45 ? 'BEARISH' : 'NEUTRAL',
                closePrice: closes15m[closes15m.length - 1],
                ema20: ema20_15m,
                ema50: ema50_15m,
                rsi14: rsi14_15m,
                atr14: atr14_15m,
                candleTimestamp: candles15m[candles15m.length - 1]?.openTime || cycleTimestamp,
                isFresh: true,
              },
              '5m': {
                timeframe: '5m',
                trend: is5mBull ? 'BULLISH' : is5mBear ? 'BEARISH' : 'NEUTRAL',
                momentum: rsi14_5m > 55 ? 'BULLISH' : rsi14_5m < 45 ? 'BEARISH' : 'NEUTRAL',
                closePrice: closes5m[closes5m.length - 1],
                ema20: ema9_5m,
                ema50: ema21_5m,
                rsi14: rsi14_5m,
                atr14: atr14_5m,
                candleTimestamp: candles5m[candles5m.length - 1]?.openTime || cycleTimestamp,
                isFresh: true,
              },
            };

            const primaryStrategy = primaryCompatibility[0]?.strategyId || (dominantDirection === 'SHORT' ? 'VWAP' : 'ScalperV2');
            const primaryOpportunityId = `${symbol}:${primaryStrategy}:${dominantDirection}`;

            const symbolOpportunities: MarketOpportunity[] = [];

            const primaryOpportunity: MarketOpportunity = {
              opportunityId: primaryOpportunityId,
              symbol,
              timestamp: cycleTimestamp,
              state,
              dominantDirection,
              marketQuality: currentMarketQuality,
              marketRegime: regime,
              mtfState,
              timeframes,
              longEvaluation,
              shortEvaluation,
              strategyCompatibility: primaryCompatibility,
              rawFactors,
              opportunityScore,
              reasons,
              warnings,
              currentRank: null,
              previousRank: null,
              lastStateTransitionAt: cycleTimestamp,
              currentStrategySignal: {
                hasActiveSignal: false, // Authoritative signal engine remains isolated
              },
            };
            symbolOpportunities.push(primaryOpportunity);

            // Secondary Opportunity Evaluation:
            // If the opposite direction has a viable setup and compatible strategy, generate a secondary opportunity
            // (e.g. ETH/USDT:ScalperV2:LONG and ETH/USDT:VWAP:SHORT)
            const secondaryDirection = dominantDirection === 'LONG' ? 'SHORT' : 'LONG';
            const secondaryEvaluation = secondaryDirection === 'LONG' ? longEvaluation : shortEvaluation;
            const secondaryCompatibility = secondaryDirection === 'LONG' ? longCompatibility : shortCompatibility;

            if (secondaryEvaluation.isViable && secondaryCompatibility.length > 0) {
              const secondaryStrategy = secondaryCompatibility[0]?.strategyId || (secondaryDirection === 'SHORT' ? 'VWAP' : 'ScalperV2');
              const secondaryActiveMtfScore = secondaryDirection === 'LONG' ? mtfLongScore : mtfShortScore;
              const secondaryActiveMomentumScore = secondaryDirection === 'LONG' ? momentumLongScore : momentumShortScore;
              const secondaryRegimeFitScore = Math.max(...secondaryCompatibility.map(c => c.compatibilityScore), 0);

              const secondaryRawScore = Math.round(
                (secondaryActiveMtfScore * weights.mtfAlignment / 100) +
                (secondaryRegimeFitScore * weights.regimeAndStrategyFit / 100) +
                (secondaryActiveMomentumScore * weights.momentumAndVolume / 100) +
                (costBreakdown.feasibilityScore * weights.costFeasibility / 100)
              );
              const secondaryOpportunityScore = Math.min(100, Math.max(0, secondaryRawScore));

              if (secondaryOpportunityScore >= 60) {
                symbolOpportunities.push({
                  opportunityId: `${symbol}:${secondaryStrategy}:${secondaryDirection}`,
                  symbol,
                  timestamp: cycleTimestamp,
                  state: secondaryOpportunityScore >= 75 ? 'HIGH_CONVICTION' : 'QUALIFIED',
                  dominantDirection: secondaryDirection,
                  marketQuality: currentMarketQuality,
                  marketRegime: regime,
                  mtfState,
                  timeframes,
                  longEvaluation,
                  shortEvaluation,
                  strategyCompatibility: secondaryCompatibility,
                  rawFactors: {
                    ...rawFactors,
                    mtfAlignmentScore: secondaryActiveMtfScore,
                    momentumScore: secondaryActiveMomentumScore,
                  },
                  opportunityScore: secondaryOpportunityScore,
                  reasons: [
                    ...costBreakdown.reasons,
                    `Viable secondary setup (${secondaryDirection}).`,
                  ],
                  warnings: [...costBreakdown.warnings],
                  currentRank: null,
                  previousRank: null,
                  lastStateTransitionAt: cycleTimestamp,
                  currentStrategySignal: {
                    hasActiveSignal: false,
                  },
                });
              }
            }

            return symbolOpportunities;
          } catch (err: any) {
            this.logger.error(`[MarketOpportunityScanner] Error scanning ${symbol}:`, err);
            return null;
          }
        })
      );

      for (const res of batchResults) {
        if (res && Array.isArray(res)) {
          evaluatedOpportunities.push(...res);
        } else if (res) {
          evaluatedOpportunities.push(res);
        }
      }
    }

    const screenedCount = evaluatedOpportunities.length;

    // Deduplicate identical opportunities by opportunityId
    // Identity rule: Opportunity Identity = Instrument + Strategy ID + Direction
    // Two identical records with that identity are duplicates.
    // Different identities (e.g. ETH/USDT:ScalperV2:LONG vs ETH/USDT:Momentum:SHORT) are preserved.
    const seenOpportunityIds = new Set<string>();
    const distinctEvaluatedOpportunities: MarketOpportunity[] = [];
    for (const opp of evaluatedOpportunities) {
      const oppId = opp.opportunityId || `${opp.symbol}:${opp.strategyCompatibility?.[0]?.strategyId || 'Default'}:${opp.dominantDirection}`;
      if (seenOpportunityIds.has(oppId)) continue;
      seenOpportunityIds.add(oppId);
      distinctEvaluatedOpportunities.push(opp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 8: Opportunity Ranking & Anti-Churn Hysteresis
    // ─────────────────────────────────────────────────────────────────────────
    const rankerResult: RankerOutput = this.ranker.rank(distinctEvaluatedOpportunities, cycleTimestamp);

    const executionDurationMs = Math.round(performance.now() - startTime);

    // Build Structured Telemetry Record
    const telemetry: ScannerTelemetryRecord = {
      cycleId,
      timestamp: cycleTimestamp,
      executionDurationMs,
      universeSize,
      eligibleCount,
      qualityCount,
      screenedCount,
      deepScanCount: screenedCount,
      qualifiedOpportunityCount: rankerResult.allQualifiedOpportunities.length,
      opportunities: rankerResult.topOpportunities.map(o => ({
        symbol: o.symbol,
        rank: o.currentRank,
        dominantDirection: o.dominantDirection,
        state: o.state,
        opportunityScore: o.opportunityScore,
        factorScores: {
          mtfScore: o.rawFactors.mtfAlignmentScore,
          regimeScore: o.rawFactors.regimeScore,
          momentumScore: o.rawFactors.momentumScore,
          feasibilityScore: o.rawFactors.netEdgeRatio * 20,
        },
        rawMetrics: {
          adx14: o.rawFactors.adx14,
          emaSlope20: o.rawFactors.emaSlope20,
          atrExpansionRatio: o.rawFactors.atrExpansionRatio,
          spreadPercent: o.rawFactors.spreadPercent,
          netEdgeRatio: o.rawFactors.netEdgeRatio,
          totalFrictionPercent: o.rawFactors.totalFrictionPercent,
        },
        compatibleStrategies: o.strategyCompatibility.filter(s => s.isAllowedInRegime).map(s => s.strategyId),
        hasActiveStrategySignal: o.currentStrategySignal?.hasActiveSignal ?? false,
      })),
    };

    // Record metrics in passive observation engine
    const metrics = MetricsEngine.getInstance();
    metrics.record({
      type: 'ORCHESTRATOR_CYCLE',
      symbol: 'MARKET_SCANNER',
      totalStrategies: rankerResult.allQualifiedOpportunities.length,
      successfulEvaluations: rankerResult.allQualifiedOpportunities.length,
      failedEvaluations: 0,
      skippedEvaluations: rankerResult.invalidatedCount + rankerResult.degradedCount,
      buySignals: rankerResult.allQualifiedOpportunities.filter(o => o.dominantDirection === 'LONG').length,
      sellSignals: rankerResult.allQualifiedOpportunities.filter(o => o.dominantDirection === 'SHORT').length,
      totalDurationMs: executionDurationMs,
      timestamp: cycleTimestamp,
    });

    this.logger.info(`[MarketOpportunityScanner] Full universe scan completed in ${executionDurationMs}ms. Universe: ${universeSize} -> Eligible: ${eligibleCount} -> Quality: ${qualityCount} -> Qualified: ${rankerResult.allQualifiedOpportunities.length}`);

    return {
      timestamp: cycleTimestamp,
      executionDurationMs,
      universeSize,
      eligibleCount,
      qualityCount,
      screenedCount,
      allQualifiedOpportunities: rankerResult.allQualifiedOpportunities,
      topOpportunities: rankerResult.topOpportunities,
      telemetry,
    };
  }

  private calculateEMASimple(closes: number[], period: number): number {
    if (closes.length === 0) return 0;
    if (closes.length < period) return closes[closes.length - 1];
    const multiplier = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * multiplier + ema;
    }
    return ema;
  }

  private calculateRSISimple(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private calculateATRSimple(candles: any[], period = 14): number {
    if (candles.length < 2) return 0;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );
      trs.push(tr);
    }
    return this.calculateEMASimple(trs, period);
  }

  private buildEmptyResult(
    cycleId: string,
    timestamp: number,
    startTime: number,
    universeSize: number,
    eligibleCount: number
  ): ScannerScanResult {
    const executionDurationMs = Math.round(performance.now() - startTime);
    return {
      timestamp,
      executionDurationMs,
      universeSize,
      eligibleCount,
      qualityCount: 0,
      screenedCount: 0,
      allQualifiedOpportunities: [],
      topOpportunities: [],
      telemetry: {
        cycleId,
        timestamp,
        executionDurationMs,
        universeSize,
        eligibleCount,
        qualityCount: 0,
        screenedCount: 0,
        deepScanCount: 0,
        qualifiedOpportunityCount: 0,
        opportunities: [],
      },
    };
  }
}
