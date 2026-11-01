import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectionalMtfArbitrator } from '../../src/engine/arbitration/DirectionalMtfArbitrator';
import { MarketRegime } from '../../src/engine/regime/MarketRegimeEngine';
import { NormalizedCandle, MarketSnapshot } from '../../src/engine/market-data/MarketSnapshot';
import { EvaluationResult } from '../../src/engine/dto/EvaluationResult';
import { TradingBot } from '../../src/trading-bot';
import { ExchangeManager } from '../../src/exchanges';
import { sendTradeNotification } from '../../src/handlers/notifications';

vi.mock('../../src/crypto', () => ({
  decrypt: vi.fn().mockResolvedValue('mocked_secret_key'),
}));

vi.mock('../../src/handlers/notifications', () => ({
  sendTradeNotification: vi.fn().mockResolvedValue({ success: true }),
  sendTradeFillNotification: vi.fn().mockResolvedValue({ success: true }),
}));

function generateCandles(count: number, trend: 'UP' | 'DOWN' | 'FLAT', startPrice = 100): NormalizedCandle[] {
  const candles: NormalizedCandle[] = [];
  let price = startPrice;
  const now = Date.now();
  const stepMs = 60 * 60 * 1000; // 1h

  for (let i = 0; i < count; i++) {
    if (trend === 'UP') {
      price += 1.0;
    } else if (trend === 'DOWN') {
      price -= 1.0;
    } else {
      price = startPrice;
    }
    const openTime = now - (count - i) * stepMs;
    candles.push({
      timestamp: openTime,
      openTime,
      closeTime: openTime + stepMs,
      open: price,
      high: price + 0.1,
      low: price - 0.1,
      close: price,
      volume: 1000,
    });
  }
  return candles;
}

function createCandidateResult(strategyId: string, side: 'BUY' | 'SELL', timeframe = '5m', confidence = 85): EvaluationResult {
  return {
    strategyId,
    timestamp: Date.now(),
    confidenceScore: confidence,
    hasSignal: true,
    metadata: {
      targetTimeframe: timeframe,
      signal: {
        symbol: 'BTC/USDT',
        timeframe,
        type: side,
        confidenceScore: confidence,
        signalPrice: 50000,
        riskAssessment: {
          riskClassification: 'LOW',
          positionSizeRecommendation: 100,
          stopLossDistance: 500,
          takeProfitDistance: 1000,
        },
        reasoning: [`Signal trigger on ${timeframe}`],
      }
    }
  };
}

describe('Stage 2 Directional & Multi-Timeframe Arbitration Suite', () => {

  describe('Part 1: Pure Arbitrator Unit Verification', () => {
    const trendingRegime: MarketRegime = {
      regime: 'TRENDING',
      score: 85,
      allowTrendStrategies: true,
      allowMeanReversion: false,
    };

    const rangingRegime: MarketRegime = {
      regime: 'RANGING',
      score: 75,
      allowTrendStrategies: false,
      allowMeanReversion: true,
    };

    const volatileTrendingRegime: MarketRegime = {
      regime: 'VOLATILE',
      score: 80,
      allowTrendStrategies: true, // ADX > 25
      allowMeanReversion: false,
    };

    const volatileChoppyRegime: MarketRegime = {
      regime: 'VOLATILE',
      score: 55,
      allowTrendStrategies: false,
      allowMeanReversion: false,
    };

    it('1. Mandatory Safety Condition A: Missing regime fails closed across all strategies', () => {
      const snapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'UP'),
          '4h': generateCandles(60, 'UP'),
        } as any,
      };

      const strategies = ['ScalperV2', 'Momentum', 'Breakout', 'MeanReversion', 'VWAP'];
      for (const strat of strategies) {
        const candidate = createCandidateResult(strat, 'BUY');
        const res = DirectionalMtfArbitrator.evaluateCandidate(candidate, snapshot, null);
        expect(res.passed).toBe(false);
        expect(res.gate).toBe('REGIME_PROHIBITED');
        expect(res.reasoning).toContain('Market regime unavailable');
      }
    });

    it('2. Mandatory Safety Condition B: Strategy-specific regime permissions enforce strictly', () => {
      const snapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'UP'),
          '4h': generateCandles(60, 'UP'),
        } as any,
      };

      // In TRENDING: Breakout, Momentum, VWAP allowed; MeanReversion HARD-REJECTED
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Breakout', 'BUY'), snapshot, trendingRegime).passed).toBe(true);
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'BUY'), snapshot, trendingRegime).passed).toBe(true);
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('VWAP', 'BUY'), snapshot, trendingRegime).passed).toBe(true);

      const meanRevInTrend = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('MeanReversion', 'BUY'), snapshot, trendingRegime);
      expect(meanRevInTrend.passed).toBe(false);
      expect(meanRevInTrend.gate).toBe('REGIME_PROHIBITED');

      // In RANGING: MeanReversion allowed; Breakout & Momentum REJECTED
      const rangingSnapshot: MarketSnapshot = {
        ...snapshot,
        candles: {
          '1h': generateCandles(60, 'FLAT'),
          '4h': generateCandles(60, 'FLAT'),
        } as any,
      };
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('MeanReversion', 'BUY'), rangingSnapshot, rangingRegime).passed).toBe(true);
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Breakout', 'BUY'), rangingSnapshot, rangingRegime).passed).toBe(false);
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'BUY'), rangingSnapshot, rangingRegime).passed).toBe(false);

      // ScalperV2 score check
      const lowScoreRegime: MarketRegime = { regime: 'RANGING', score: 45, allowTrendStrategies: false, allowMeanReversion: true };
      const scalperLow = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('ScalperV2', 'BUY'), snapshot, lowScoreRegime);
      expect(scalperLow.passed).toBe(false);
      expect(scalperLow.gate).toBe('REGIME_PROHIBITED');

      // VWAP volatility score check
      const vwapBlocked = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('VWAP', 'BUY'), snapshot, volatileChoppyRegime);
      expect(vwapBlocked.passed).toBe(false);
      expect(vwapBlocked.gate).toBe('REGIME_PROHIBITED');
    });

    it('3. EMA(50) history requirement: < 50 closed candles fails closed to MISSING', () => {
      const fewCandles = generateCandles(30, 'UP');
      expect(DirectionalMtfArbitrator.resolveHtfDirection(fewCandles)).toBe('MISSING');
      expect(DirectionalMtfArbitrator.resolveHtfDirection(undefined)).toBe('MISSING');

      const sufficientCandles = generateCandles(60, 'UP');
      expect(DirectionalMtfArbitrator.resolveHtfDirection(sufficientCandles)).toBe('BULLISH');
    });

    it('4. Invalid numeric values in candles fail closed to MISSING', () => {
      const candlesWithNaN = generateCandles(60, 'UP');
      candlesWithNaN[55].close = NaN;
      expect(DirectionalMtfArbitrator.resolveHtfDirection(candlesWithNaN)).toBe('MISSING');

      const candlesWithNegative = generateCandles(60, 'UP');
      candlesWithNegative[55].close = -10;
      expect(DirectionalMtfArbitrator.resolveHtfDirection(candlesWithNegative)).toBe('MISSING');
    });

    it('5. BUY/SELL Directional Symmetry across Trend Strategies', () => {
      const bullSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'UP'),
          '4h': generateCandles(60, 'UP'),
        } as any,
      };

      const bearSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'DOWN'),
          '4h': generateCandles(60, 'DOWN'),
        } as any,
      };

      // Bullish HTF: BUY passes, SELL rejects
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'BUY'), bullSnapshot, trendingRegime).passed).toBe(true);
      const momSellInBull = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'SELL'), bullSnapshot, trendingRegime);
      expect(momSellInBull.passed).toBe(false);
      expect(momSellInBull.gate).toBe('HTF_CONFLICT');

      // Bearish HTF: SELL passes, BUY rejects
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'SELL'), bearSnapshot, trendingRegime).passed).toBe(true);
      const momBuyInBear = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'BUY'), bearSnapshot, trendingRegime);
      expect(momBuyInBear.passed).toBe(false);
      expect(momBuyInBear.gate).toBe('HTF_CONFLICT');
    });

    it('6. Reconciled MeanReversion: Dip buys pass in 4h bull trend, rally shorts pass in 4h bear trend', () => {
      // 1h BEARISH, 4h BULLISH in Ranging regime: textbook dip buy
      const pullbackSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'DOWN'),
          '4h': generateCandles(60, 'UP'),
        } as any,
      };
      const meanRevBuy = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('MeanReversion', 'BUY'), pullbackSnapshot, rangingRegime);
      expect(meanRevBuy.passed).toBe(true);
      expect(meanRevBuy.gate).toBe('PASS');

      // MeanReversion SELL during 1h pullback in 4h bull trend is rejected (selling into bull trend support)
      const meanRevSellInBull = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('MeanReversion', 'SELL'), pullbackSnapshot, rangingRegime);
      expect(meanRevSellInBull.passed).toBe(false);
      expect(meanRevSellInBull.gate).toBe('HTF_CONFLICT');

      // 1h BULLISH, 4h BEARISH in Ranging regime: textbook relief rally short
      const reliefSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'UP'),
          '4h': generateCandles(60, 'DOWN'),
        } as any,
      };
      const meanRevSell = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('MeanReversion', 'SELL'), reliefSnapshot, rangingRegime);
      expect(meanRevSell.passed).toBe(true);
      expect(meanRevSell.gate).toBe('PASS');

      // MeanReversion BUY into 4h downtrend resistance is rejected
      const meanRevBuyInBear = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('MeanReversion', 'BUY'), reliefSnapshot, rangingRegime);
      expect(meanRevBuyInBear.passed).toBe(false);
      expect(meanRevBuyInBear.gate).toBe('HTF_CONFLICT');
    });

    it('7. MeanReversion Falling Knife Protection: Double opposing HTF strictly rejected', () => {
      const doubleBearSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'DOWN'),
          '4h': generateCandles(60, 'DOWN'),
        } as any,
      };
      const meanRevBuy = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('MeanReversion', 'BUY'), doubleBearSnapshot, rangingRegime);
      expect(meanRevBuy.passed).toBe(false);
      expect(meanRevBuy.gate).toBe('HTF_CONFLICT');
      expect(meanRevBuy.reasoning).toContain('runaway trend risk');
    });

    it('8. Partial HTF Data Availability: Graceful confirmation & fail-closed on blackout', () => {
      // 1h MISSING, 4h BULLISH: Trend BUY passes
      const missing1hSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': [],
          '4h': generateCandles(60, 'UP'),
        } as any,
      };
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'BUY'), missing1hSnapshot, trendingRegime).passed).toBe(true);

      // 1h BULLISH, 4h MISSING: Trend BUY passes
      const missing4hSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'UP'),
          '4h': [],
        } as any,
      };
      expect(DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'BUY'), missing4hSnapshot, trendingRegime).passed).toBe(true);

      // Both MISSING: Rejects with INSUFFICIENT_HTF_DATA
      const blackoutSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': [],
          '4h': [],
        } as any,
      };
      const blackoutRes = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'BUY'), blackoutSnapshot, trendingRegime);
      expect(blackoutRes.passed).toBe(false);
      expect(blackoutRes.gate).toBe('INSUFFICIENT_HTF_DATA');

      // 1h NEUTRAL, 4h MISSING: Incomplete data without confirmation rejects Trend BUY
      const neutralMissingSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'FLAT'),
          '4h': [],
        } as any,
      };
      const neutMissRes = DirectionalMtfArbitrator.evaluateCandidate(createCandidateResult('Momentum', 'BUY'), neutralMissingSnapshot, trendingRegime);
      expect(neutMissRes.passed).toBe(false);
      expect(neutMissRes.gate).toBe('INSUFFICIENT_HTF_DATA');
    });

    it('8b. DEF-01: Strategy ID Normalization and Strict Alias / Unknown Strategy Fail-Closed Handling', () => {
      // 1h BEARISH, 4h BULLISH snapshot:
      // - For Trend strategies: 1h BEARISH must REJECT a BUY candidate (Rule 1A: single opposing HTF veto)
      // - Under VWAP rules: 1h BEARISH + 4h BULLISH would PASS (Rule 3: only double opposing rejects)
      const mixedHtfSnapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '1h': generateCandles(60, 'DOWN'), // BEARISH
          '4h': generateCandles(60, 'UP'),   // BULLISH
        } as any,
      };

      // 1. ScalperV2 and supported aliases ('scalper-v2', 'scalping', 'scalperv2')
      const scalperCanonical = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('ScalperV2', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(scalperCanonical.passed).toBe(false);
      expect(scalperCanonical.gate).toBe('HTF_CONFLICT');

      const scalperKebab = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('scalper-v2', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(scalperKebab.passed).toBe(false);
      expect(scalperKebab.gate).toBe('HTF_CONFLICT');
      expect(scalperKebab.reasoning).toContain('ScalperV2');

      const scalpingAlias = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('scalping', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(scalpingAlias.passed).toBe(false);
      expect(scalpingAlias.gate).toBe('HTF_CONFLICT');

      // 2. Momentum and lowercase alias ('momentum')
      const momentumCanonical = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('Momentum', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(momentumCanonical.passed).toBe(false);
      expect(momentumCanonical.gate).toBe('HTF_CONFLICT');

      const momentumLower = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('momentum', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(momentumLower.passed).toBe(false);
      expect(momentumLower.gate).toBe('HTF_CONFLICT');
      expect(momentumLower.reasoning).toContain('Momentum');

      // 3. Breakout and lowercase alias ('breakout')
      const breakoutCanonical = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('Breakout', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(breakoutCanonical.passed).toBe(false);
      expect(breakoutCanonical.gate).toBe('HTF_CONFLICT');

      const breakoutLower = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('breakout', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(breakoutLower.passed).toBe(false);
      expect(breakoutLower.gate).toBe('HTF_CONFLICT');
      expect(breakoutLower.reasoning).toContain('Breakout');

      // 4. MeanReversion and aliases ('mean-reversion', 'reversion'):
      // In mixed snapshot (1h DOWN, 4h UP) with Ranging regime, MeanReversion dip BUY passes
      const meanRevCanonical = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('MeanReversion', 'BUY'),
        mixedHtfSnapshot,
        rangingRegime
      );
      expect(meanRevCanonical.passed).toBe(true);
      expect(meanRevCanonical.gate).toBe('PASS');

      const meanRevKebab = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('mean-reversion', 'BUY'),
        mixedHtfSnapshot,
        rangingRegime
      );
      expect(meanRevKebab.passed).toBe(true);
      expect(meanRevKebab.gate).toBe('PASS');

      const meanRevReversion = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('reversion', 'BUY'),
        mixedHtfSnapshot,
        rangingRegime
      );
      expect(meanRevReversion.passed).toBe(true);
      expect(meanRevReversion.gate).toBe('PASS');

      // 5. VWAP and alias ('vwap'):
      // In mixed snapshot, VWAP BUY passes because only double opposing opposes it
      const vwapCanonical = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('VWAP', 'BUY'),
        mixedHtfSnapshot,
        rangingRegime
      );
      expect(vwapCanonical.passed).toBe(true);
      expect(vwapCanonical.gate).toBe('PASS');

      const vwapLower = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('vwap', 'BUY'),
        mixedHtfSnapshot,
        rangingRegime
      );
      expect(vwapLower.passed).toBe(true);
      expect(vwapLower.gate).toBe('PASS');

      // 6. Unknown Strategy IDs: must fail closed explicitly with REGIME_PROHIBITED
      const unknownRes = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('UnknownStrategy', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(unknownRes.passed).toBe(false);
      expect(unknownRes.gate).toBe('REGIME_PROHIBITED');
      expect(unknownRes.reasoning).toContain('Unknown strategy ID');

      const customRes = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('custom-arbitrage', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(customRes.passed).toBe(false);
      expect(customRes.gate).toBe('REGIME_PROHIBITED');

      // 7. Invalid/missing strategy ID
      const missingIdRes = DirectionalMtfArbitrator.evaluateCandidate(
        createCandidateResult('', 'BUY'),
        mixedHtfSnapshot,
        trendingRegime
      );
      expect(missingIdRes.passed).toBe(false);
      expect(missingIdRes.gate).toBe('INSUFFICIENT_HTF_DATA');
    });
  });

  describe('Part 2: TradingBot.alarm() Integration & Sequential Fallback', () => {
    let mockStorage: Map<string, any>;
    let mockState: any;
    let mockEnv: any;
    let mockAdapter: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockStorage = new Map();

      mockAdapter = {
        fetchTicker: vi.fn().mockResolvedValue({ symbol: 'BTCUSDT', last: 50000 }),
        fetchKlines: vi.fn().mockResolvedValue([]),
        fetchBalance: vi.fn().mockResolvedValue({
          info: { result: { list: [{ coin: [{ coin: 'USDT', equity: '1000', walletBalance: '1000' }] }] } }
        }),
        fetchMarkets: vi.fn().mockResolvedValue([
          { id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } },
        ]),
        fetchMarket: vi.fn().mockResolvedValue(
          { id: 'BTCUSDT', symbol: 'BTC/USDT', active: true, category: 'linear', precision: { amount: 0.001, price: 0.1 }, limits: { cost: { min: 5 }, amount: { min: 0.001, max: 1000 } } }
        ),
        createOrder: vi.fn().mockResolvedValue({ id: 'ord-1', status: 'closed' }),
      };

      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue(mockAdapter);

      mockState = {
        id: { toString: () => 'mock-do-id' },
        storage: {
          get: async (keyOrKeys: string | string[]) => {
            if (Array.isArray(keyOrKeys)) {
              const res: Record<string, any> = {};
              for (const k of keyOrKeys) {
                res[k] = mockStorage.get(k);
              }
              return res;
            }
            return mockStorage.get(keyOrKeys);
          },
          put: async (key: string, val: any) => {
            mockStorage.set(key, val);
          },
          delete: async (key: string) => {
            mockStorage.delete(key);
          },
          list: async () => mockStorage,
          setAlarm: vi.fn(),
          deleteAlarm: vi.fn(),
          getAlarm: vi.fn(),
        },
        blockConcurrencyWhile: async (fn: any) => fn(),
      };

      const mockDb = {
        prepare: vi.fn().mockImplementation((_q: string) => ({
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true }),
            first: vi.fn().mockResolvedValue({
              exchange_name: 'bybit',
              exchange_environment: 'demo',
              exchange_region: 'global',
              exchange_api_key: 'test_key',
              exchange_api_secret_iv: 'bW9ja19pdk1vY2tJdk1vY2s=',
              exchange_api_secret_encrypted: 'test_sec',
            }),
          }),
        })),
        run: vi.fn().mockResolvedValue({ success: true }),
      };

      mockEnv = {
        DB: mockDb,
        ENCRYPTION_KEY: 'test_encryption_key_32_bytes_long!!',
        EXECUTION_MODE: 'autonomous',
        SIGNAL_MANAGER_MODE: 'SHADOW',
      };

      mockStorage.set('userId', 'usr-stage2');
      mockStorage.set('isActive', true);
      mockStorage.set('lock:alarmGeneration', 1);
      mockStorage.set('monitoredSymbols', ['BTC/USDT']);
      mockStorage.set('strategy', 'ScalperV2');
      mockStorage.set('strategyConfig', {
        riskParameters: { maxExposureLimit: 100 },
        confidenceWeights: { trend: 30, momentum: 30, volatility: 20, volume: 20 },
      });
      mockStorage.set('user', {
        id: 'usr-stage2',
        apiKey: 'encrypted_key',
        secretKey: 'encrypted_secret',
        exchange: 'bybit',
        environment: 'testnet',
        password: 'pass',
        region: 'US',
      });
    });

    it('9. Fallback on HTF Conflict: ScalperV2 BUY rejected by 1h/4h BEARISH; Momentum SELL approved and creates alert', async () => {
      // 1h and 4h are BEARISH
      const bearCandles = generateCandles(60, 'DOWN', 50000);
      mockAdapter.fetchKlines.mockResolvedValue(bearCandles);

      const bot = new TradingBot(mockState, mockEnv);
      const candidates = [
        createCandidateResult('ScalperV2', 'BUY', '5m', 90),   // Opposes 1h/4h BEARISH -> should be rejected by Gate 4.5
        createCandidateResult('Momentum', 'SELL', '15m', 85),  // Confirms 1h/4h BEARISH -> should pass Gate 4.5 and create TradeAlert!
      ];

      (bot as any).orchestrator = {
        executeCycle: vi.fn().mockResolvedValue(candidates),
        getCurrentState: vi.fn().mockReturnValue('WAITING'),
        setMarketDataEngine: vi.fn(),
      };

      vi.spyOn(bot as any, 'resolveMaxPortfolioExposure').mockReturnValue(10000);
      vi.spyOn(bot as any, 'calculateAggregateExposure').mockReturnValue(0);

      await bot.alarm();

      const savedAlerts = mockStorage.get('alerts') || [];
      expect(savedAlerts.length).toBe(1);
      // The alert MUST be from Momentum, NOT ScalperV2!
      expect(savedAlerts[0].strategy).toBe('Momentum_NEW');
      expect(savedAlerts[0].side).toBe('SELL');
      expect(sendTradeNotification).toHaveBeenCalledTimes(1);
    });

    it('10. MeanReversion hard-rejected when regime.allowMeanReversion === false', async () => {
      // Uptrend snapshot produces TRENDING regime with high ADX -> allowMeanReversion is false
      const bullCandles = generateCandles(60, 'UP', 50000);
      mockAdapter.fetchKlines.mockResolvedValue(bullCandles);

      const bot = new TradingBot(mockState, mockEnv);
      const candidates = [
        createCandidateResult('MeanReversion', 'BUY', '15m', 80), // Disallowed in TRENDING regime
      ];

      (bot as any).orchestrator = {
        executeCycle: vi.fn().mockResolvedValue(candidates),
        getCurrentState: vi.fn().mockReturnValue('WAITING'),
        setMarketDataEngine: vi.fn(),
      };

      vi.spyOn(bot as any, 'resolveMaxPortfolioExposure').mockReturnValue(10000);
      vi.spyOn(bot as any, 'calculateAggregateExposure').mockReturnValue(0);

      await bot.alarm();

      const savedAlerts = mockStorage.get('alerts') || [];
      expect(savedAlerts.length).toBe(0); // MeanReversion was cleanly rejected by Gate 4.5
    });

    it('11. Zero additional exchange candle requests: arbitration uses in-memory snapshot with 0 extra subrequests', async () => {
      const bullCandles = generateCandles(60, 'UP', 50000);
      mockAdapter.fetchKlines.mockResolvedValue(bullCandles);

      const bot = new TradingBot(mockState, mockEnv);
      const candidates = [
        createCandidateResult('ScalperV2', 'BUY', '5m', 90),
      ];

      (bot as any).orchestrator = {
        executeCycle: vi.fn().mockResolvedValue(candidates),
        getCurrentState: vi.fn().mockReturnValue('WAITING'),
        setMarketDataEngine: vi.fn(),
      };

      vi.spyOn(bot as any, 'resolveMaxPortfolioExposure').mockReturnValue(10000);
      vi.spyOn(bot as any, 'calculateAggregateExposure').mockReturnValue(0);

      await bot.alarm();

      // Only the initial snapshot load fetched candles; arbitration made 0 extra calls
      const callsForSymbol = mockAdapter.fetchKlines.mock.calls.filter((c: any) => c[0] === 'BTC/USDT');
      // Exactly 4 timeframe calls from initial getSnapshot (5m, 15m, 1h, 4h), zero from arbitration
      expect(callsForSymbol.length).toBe(4);
    });

    it('12. Existing ticker-wide break and lifecycle return behavior are preserved', async () => {
      const bullCandles = generateCandles(60, 'UP', 50000);
      const snapshot: MarketSnapshot = {
        symbol: 'BTC/USDT',
        timestamp: Date.now(),
        currentPrice: 50000,
        volume24h: 1000,
        quoteVolume24h: 50000000,
        candles: {
          '5m': bullCandles,
          '15m': bullCandles,
          '1h': bullCandles,
          '4h': bullCandles,
        } as any,
      };

      // Ticker already has an active position -> break (ticker-wide)
      mockStorage.set('activePositions', [{ id: 'pos-1', symbol: 'BTC/USDT', status: 'OPEN', side: 'BUY' }]);

      const bot = new TradingBot(mockState, mockEnv);
      const candidates = [
        createCandidateResult('ScalperV2', 'BUY', '5m', 95),
        createCandidateResult('Momentum', 'BUY', '15m', 90),
      ];

      (bot as any).orchestrator = {
        executeCycle: vi.fn().mockResolvedValue(candidates),
        getCurrentState: vi.fn().mockReturnValue('WAITING'),
        setMarketDataEngine: vi.fn(),
      };

      await bot.alarm();

      // Ticker-wide gate halted evaluation before creating any alert
      const savedAlerts = mockStorage.get('alerts') || [];
      expect(savedAlerts.length).toBe(0);
    });
  });
});
