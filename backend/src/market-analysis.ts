import { type MarketTicker, type IExchangeAdapter } from "./exchanges";

export interface AnalysisCandidate extends MarketTicker {
  score: number;
  rank: number;
  recommendedTimeframe: string;
  tradeSide: "BUY" | "SELL";
}

function calculateEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1];
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(closes: number[], period = 14): number {
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
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export async function analyzeMarket(
  tickers: MarketTicker[],
  adapter: IExchangeAdapter,
): Promise<AnalysisCandidate[]> {
  if (!tickers.length) return [];

  const MIN_VOLUME_USDT = 500_000;
  const MAX_DECLINE_PERCENT = -50;
  
  // Filter out weak/illiquid/declining coins
  const filtered = tickers.filter(
    (ticker) =>
      (ticker.quoteVolume24h || ticker.volume24h || 0) >= MIN_VOLUME_USDT &&
      ticker.priceChangePercent24h >= MAX_DECLINE_PERCENT,
  );

  if (!filtered.length) return [];

  // Rank by 24h score first (Pass 1)
  const scored = filtered.map((ticker) => ({
    ...ticker,
    score: calculateScore(ticker),
  }));

  scored.sort((a, b) => b.score - a.score);
  
  // Take top 15 candidates for intraday analysis to stay within rate and CPU limits
  const top15 = scored.slice(0, 15);

  // Concurrently evaluate intraday timeframes (Pass 2)
  const analyzed = await Promise.all(
    top15.map(async (candidate) => {
      try {
        const [klines1h, klines15m] = await Promise.all([
          adapter.fetchKlines(candidate.symbol, "1h", 30),
          adapter.fetchKlines(candidate.symbol, "15m", 30),
        ]);

        if (klines1h.length < 20 || klines15m.length < 20) {
          return {
            ...candidate,
            recommendedTimeframe: "1h",
            tradeSide: (candidate.priceChangePercent24h > 0 ? "BUY" : "SELL") as "BUY" | "SELL",
          };
        }

        const closes1h = klines1h.map((k) => k.close);
        const ema20_1h = calculateEMA(closes1h, 20);
        const ema50_1h = calculateEMA(closes1h, 50);
        const rsi1h = calculateRSI(closes1h, 14);

        const closes15m = klines15m.map((k) => k.close);
        const ema20_15m = calculateEMA(closes15m, 20);
        const ema50_15m = calculateEMA(closes15m, 50);
        const rsi15m = calculateRSI(closes15m, 14);

        let side1h: "BUY" | "SELL" | "HOLD" = "HOLD";
        if (ema20_1h > ema50_1h && rsi1h > 50) side1h = "BUY";
        else if (ema20_1h < ema50_1h && rsi1h < 50) side1h = "SELL";

        let side15m: "BUY" | "SELL" | "HOLD" = "HOLD";
        if (ema20_15m > ema50_15m && rsi15m > 50) side15m = "BUY";
        else if (ema20_15m < ema50_15m && rsi15m < 50) side15m = "SELL";

        if (side1h !== "HOLD" && side1h === side15m) {
          return {
            ...candidate,
            recommendedTimeframe: "1h",
            tradeSide: side1h,
          };
        }

        if (side1h !== "HOLD") {
          return {
            ...candidate,
            recommendedTimeframe: "1h",
            tradeSide: side1h,
          };
        }

        if (side15m !== "HOLD") {
          return {
            ...candidate,
            recommendedTimeframe: "15m",
            tradeSide: side15m,
          };
        }

        return {
          ...candidate,
          recommendedTimeframe: "1h",
          tradeSide: (candidate.priceChangePercent24h > 0 ? "BUY" : "SELL") as "BUY" | "SELL",
        };
      } catch (err) {
        console.error(`[market-analysis] Error analyzing klines for ${candidate.symbol}:`, err);
        return {
          ...candidate,
          recommendedTimeframe: "1h",
          tradeSide: (candidate.priceChangePercent24h > 0 ? "BUY" : "SELL") as "BUY" | "SELL",
        };
      }
    })
  );

  // Return the Top 10 ranked candidates
  return analyzed.slice(0, 10).map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

function calculateScore(ticker: MarketTicker): number {
  const volume = ticker.quoteVolume24h || ticker.volume24h || 0;
  const volumeScore = Math.min(Math.log10(volume + 1) * 5, 30);

  const volatility = Math.abs(ticker.priceChangePercent24h);
  const volatilityScore = Math.min(volatility * 3, 30);

  const range = ticker.highPrice24h - ticker.lowPrice24h;
  const rangePercent = ticker.price > 0 ? (range / ticker.price) * 100 : 0;
  const rangeScore = Math.min(rangePercent * 3, 20);

  const changePercent = ticker.priceChangePercent24h;
  const momentumScore = Math.min(Math.abs(changePercent) * 3, 30);
  const trendDirectionScore = Math.max(-40, Math.min(40, changePercent * 4));

  return (
    volumeScore +
    volatilityScore +
    rangeScore +
    momentumScore +
    trendDirectionScore
  );
}
