import { type IExchangeProvider } from "./exchanges";

export interface AnalysisCandidate {
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
  tickers: any[],
  adapter: IExchangeProvider,
): Promise<AnalysisCandidate[]> {
  const startTime = Date.now();
  console.log(`[MARKET_ANALYSIS_START] Beginning market evaluation for ${tickers.length} input tickers.`);
  if (!tickers || !tickers.length) {
    console.warn(`[MARKET_ANALYSIS_EMPTY] Input tickers array is empty. Returning 0 candidates.`);
    return [];
  }

  const MIN_VOLUME_USDT = 500_000;
  const MAX_DECLINE_PERCENT = -50;
  
  const STABLECOINS = ["USDT", "USDC", "BUSD", "TUSD", "FDUSD", "DAI", "USDP"];
  
  // Filter out weak/illiquid/declining coins, and stablecoins
  let filtered = tickers.filter(
    (ticker) =>
      (Number(ticker.quoteVolume24h ?? ticker.volume24h ?? 1_000_000)) >= MIN_VOLUME_USDT &&
      (Number(ticker.priceChangePercent24h ?? 0)) >= MAX_DECLINE_PERCENT &&
      !STABLECOINS.includes(String(ticker.symbol || ""))
  );

  if (!filtered.length) {
    console.warn(`[MARKET_ANALYSIS_WARN] Primary volume filter yielded 0 candidates. Falling back to non-stablecoin tickers.`);
    filtered = tickers.filter((ticker) => !STABLECOINS.includes(String(ticker.symbol || "")));
  }

  console.log(`[MARKET_ANALYSIS_FILTER] Filtered ${tickers.length} tickers down to ${filtered.length} eligible candidates.`);
  if (!filtered.length) {
    console.warn(`[MARKET_ANALYSIS_EMPTY] Zero candidates remaining after filtering. Returning 0 candidates.`);
    return [];
  }

  // Rank by 24h score first (Pass 1)
  const scored = filtered.map((ticker) => ({
    ...ticker,
    score: calculateScore(ticker),
  }));

  scored.sort((a, b) => (b.score || 0) - (a.score || 0));
  console.log(`[MARKET_ANALYSIS_SCORE] Scored ${scored.length} candidates. Top candidate: ${scored[0]?.symbol} (Score: ${scored[0]?.score}).`);
  
  // Take top 5 candidates for intraday analysis to stay well within Cloudflare Worker subrequest and CPU limits
  const top5 = scored.slice(0, 5);

  // Evaluate intraday timeframes sequentially or safely to avoid subrequest burst limit
  const analyzed: any[] = [];
  for (const candidate of top5) {
    try {
      let klines1h: any[] = [];
      let klines15m: any[] = [];

      try {
        klines1h = await adapter.fetchKlines(candidate.symbol, "1h", 100);
      } catch (kErr1: any) {
        console.warn(`[MARKET_ANALYSIS] fetchKlines 1h failed for ${candidate.symbol}:`, kErr1?.message);
      }

      try {
        klines15m = await adapter.fetchKlines(candidate.symbol, "15m", 100);
      } catch (kErr2: any) {
        console.warn(`[MARKET_ANALYSIS] fetchKlines 15m failed for ${candidate.symbol}:`, kErr2?.message);
      }

      if (!Array.isArray(klines1h) || !Array.isArray(klines15m) || klines1h.length < 20 || klines15m.length < 20) {
        analyzed.push({
          ...candidate,
          recommendedTimeframe: "1h",
          tradeSide: ((candidate.priceChangePercent24h || 0) > 0 ? "BUY" : "SELL") as "BUY" | "SELL",
        });
        continue;
      }

      const closes1h = klines1h.map((k) => Number(k.close || 0)).filter((c) => c > 0);
      const ema20_1h = calculateEMA(closes1h, 20);
      const ema50_1h = calculateEMA(closes1h, 50);
      const rsi1h = calculateRSI(closes1h, 14);

      const closes15m = klines15m.map((k) => Number(k.close || 0)).filter((c) => c > 0);
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
        analyzed.push({
          ...candidate,
          recommendedTimeframe: "1h",
          tradeSide: side1h,
        });
      } else if (side1h !== "HOLD") {
        analyzed.push({
          ...candidate,
          recommendedTimeframe: "1h",
          tradeSide: side1h,
        });
      } else if (side15m !== "HOLD") {
        analyzed.push({
          ...candidate,
          recommendedTimeframe: "15m",
          tradeSide: side15m,
        });
      } else {
        analyzed.push({
          ...candidate,
          recommendedTimeframe: "1h",
          tradeSide: ((candidate.priceChangePercent24h || 0) > 0 ? "BUY" : "SELL") as "BUY" | "SELL",
        });
      }
    } catch (err: any) {
      console.error(`[MARKET_ANALYSIS] Error analyzing candidate ${candidate?.symbol}:`, err);
      analyzed.push({
        ...candidate,
        recommendedTimeframe: "1h",
        tradeSide: ((candidate?.priceChangePercent24h || 0) > 0 ? "BUY" : "SELL") as "BUY" | "SELL",
      });
    }
  }

  const result = analyzed.slice(0, 10).map((item, index) => ({
    ...item,
    rank: index + 1,
  }));

  const durationMs = Date.now() - startTime;
  console.log(`[MARKET_ANALYSIS_COMPLETE] Generated ${result.length} shortlisted candidates in ${durationMs}ms.`);
  return result;
}

function calculateScore(ticker: any): number {
  const volume = Number(ticker.quoteVolume24h || ticker.volume24h || 0);
  const volumeScore = Math.min(Math.log10(volume + 1) * 5, 30);

  const volatility = Math.abs(Number(ticker.priceChangePercent24h || 0));
  const volatilityScore = Math.min(volatility * 3, 30);

  const price = Number(ticker.price || 0);
  const high = Number(ticker.highPrice24h || (price > 0 ? price * 1.01 : 50000));
  const low = Number(ticker.lowPrice24h || (price > 0 ? price * 0.99 : 50000));
  const range = Math.max(0, high - low);
  const rangePercent = price > 0 ? (range / price) * 100 : 0;
  const rangeScore = Math.min(rangePercent * 3, 20);

  const changePercent = Number(ticker.priceChangePercent24h || 0);
  const momentumScore = Math.min(Math.abs(changePercent) * 3, 30);
  const trendDirectionScore = Math.max(-40, Math.min(40, changePercent * 4));

  const total = volumeScore + volatilityScore + rangeScore + momentumScore + trendDirectionScore;
  return isNaN(total) ? 0 : total;
}
