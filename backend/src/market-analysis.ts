import { type IExchangeProvider } from "./exchanges";

export interface AnalysisCandidate {
  score: number;
  rank: number;
  tradeSide: "BUY" | "SELL" | "NEUTRAL";
  category?: string;
  exchangeTimestamp?: number;
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
  const LEVERAGED_TOKEN_REGEX = /.*(2L|3L|5L|2S|3S|5S)(USDT|USDC|DAI)?$/i;
  
  // Filter out weak/illiquid/declining coins, stablecoins, and leveraged tokens
  let filtered = tickers.filter(
    (ticker) =>
      (Number(ticker.quoteVolume24h ?? ticker.volume24h ?? 1_000_000)) >= MIN_VOLUME_USDT &&
      (Number(ticker.priceChangePercent24h ?? 0)) >= MAX_DECLINE_PERCENT &&
      !STABLECOINS.includes(String(ticker.symbol || "")) &&
      !LEVERAGED_TOKEN_REGEX.test(String(ticker.symbol || ""))
  );

  if (!filtered.length) {
    console.warn(`[MARKET_ANALYSIS_WARN] Primary volume filter yielded 0 candidates. Falling back to non-stablecoin/leveraged tickers.`);
    filtered = tickers.filter((ticker) => 
      !STABLECOINS.includes(String(ticker.symbol || "")) && 
      !LEVERAGED_TOKEN_REGEX.test(String(ticker.symbol || ""))
    );
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
  
  // Take top 25 candidates for intraday analysis to increase pool
  const top25 = scored.slice(0, 25);

  // Evaluate intraday timeframes using bounded concurrency to respect Cloudflare Worker subrequest limits
  const analyzed: any[] = [];
  const CONCURRENCY_LIMIT = 5;

  for (let i = 0; i < top25.length; i += CONCURRENCY_LIMIT) {
    const chunk = top25.slice(i, i + CONCURRENCY_LIMIT);

    const chunkResults = await Promise.all(
      chunk.map(async (candidate) => {
        try {
          let klines1h: any[] = [];
          let klines15m: any[] = [];

          const [res1h, res15m] = await Promise.allSettled([
            adapter.fetchKlines(candidate.symbol, "1h", 100),
            adapter.fetchKlines(candidate.symbol, "15m", 100)
          ]);

          if (res1h.status === 'fulfilled') {
            klines1h = res1h.value;
          } else {
            console.warn(`[MARKET_ANALYSIS] fetchKlines 1h failed for ${candidate.symbol}:`, res1h.reason?.message);
          }

          if (res15m.status === 'fulfilled') {
            klines15m = res15m.value;
          } else {
            console.warn(`[MARKET_ANALYSIS] fetchKlines 15m failed for ${candidate.symbol}:`, res15m.reason?.message);
          }

          if (!Array.isArray(klines1h) || !Array.isArray(klines15m) || klines1h.length < 20 || klines15m.length < 20) {
            return {
              ...candidate,
              tradeSide: "NEUTRAL" as any,
              exchangeTimestamp: candidate.timestamp,
            };
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

          let finalSide = "NEUTRAL";
          if (side1h !== "HOLD" && side1h === side15m) {
            finalSide = side1h;
          } else if (side1h !== "HOLD") {
            finalSide = side1h;
          } else if (side15m !== "HOLD") {
            finalSide = side15m;
          }
          
          return { ...candidate, tradeSide: finalSide, exchangeTimestamp: candidate.timestamp };
        } catch (err: any) {
          console.error(`[MARKET_ANALYSIS] Error analyzing candidate ${candidate?.symbol}:`, err);
          return {
            ...candidate,
            recommendedTimeframe: "1h",
            tradeSide: "NEUTRAL" as any,
            exchangeTimestamp: candidate.timestamp,
          };
        }
      })
    );

    analyzed.push(...chunkResults);
  }

  // Multi-tier sort: Active Signals (BUY/SELL) first, then raw Score
  analyzed.sort((a, b) => {
    const aIsActive = a.tradeSide === "BUY" || a.tradeSide === "SELL";
    const bIsActive = b.tradeSide === "BUY" || b.tradeSide === "SELL";
    
    // Tier 1: Active signals bubble to the top
    if (aIsActive && !bIsActive) return -1;
    if (!aIsActive && bIsActive) return 1;
    
    // Tier 2: Secondary sort by raw volume/volatility score
    return (b.score || 0) - (a.score || 0);
  });

  // Take the absolute best 10 from the re-ranked pool of 25
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
  const logVol = Math.max(0, Math.log10(volume + 1));
  const volumeScore = 30 * (1 - Math.exp(-logVol / 3));

  const volatility = Math.abs(Number(ticker.priceChangePercent24h || 0));
  const volatilityScore = 30 * (1 - Math.exp(-volatility / 10));

  const price = Number(ticker.price || 0);
  const high = Number(ticker.highPrice24h || price || 0);
  const low = Number(ticker.lowPrice24h || price || 0);
  const range = Math.max(0, high - low);
  const rangePercent = price > 0 ? (range / price) * 100 : 0;
  const rangeScore = 20 * (1 - Math.exp(-rangePercent / 10));

  const changePercent = Number(ticker.priceChangePercent24h || 0);
  const momentumScore = changePercent > 0 ? 30 * (1 - Math.exp(-changePercent / 10)) : 0;

  const trendBase = 40 * (1 - Math.exp(-Math.abs(changePercent) / 10));
  const trendDirectionScore = changePercent > 0 ? trendBase : -trendBase;

  let totalScore = volumeScore + volatilityScore + rangeScore + momentumScore + trendDirectionScore;
  if (isNaN(totalScore)) return 0;
  return Math.max(0, Math.min(150, totalScore));
}
