import { type MarketTicker } from "./exchanges";

export interface AnalysisCandidate extends MarketTicker {
  score: number;
  rank: number;
}

export function analyzeMarket(tickers: MarketTicker[]): AnalysisCandidate[] {
  if (!tickers.length) return [];

  const MIN_VOLUME_USDT = 500_000;
  const MAX_DECLINE_PERCENT = -50;
  const filtered = tickers.filter(
    (ticker) =>
      (ticker.quoteVolume24h || ticker.volume24h || 0) >= MIN_VOLUME_USDT &&
      ticker.priceChangePercent24h >= MAX_DECLINE_PERCENT,
  );

  if (!filtered.length) return [];

  const scored = filtered.map((ticker) => ({
    ...ticker,
    score: calculateScore(ticker),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 10).map((item, index) => ({
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
