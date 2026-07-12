import { type MarketTicker } from "./exchanges";

export interface AnalysisCandidate extends MarketTicker {
  score: number;
  rank: number;
}

export function analyzeMarket(tickers: MarketTicker[]): AnalysisCandidate[] {
  if (!tickers.length) return [];

  const scored = tickers.map((ticker) => ({
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
  const volumeScore = Math.min(Math.log10(ticker.volume24h + 1) * 5, 30);

  const volatility = Math.abs(ticker.priceChangePercent24h);
  const volatilityScore =
    volatility <= 1
      ? volatility * 10
      : volatility >= 20
        ? Math.max(0, 25 - (volatility - 20) * 1.5)
        : 10 + (volatility - 1) * 0.9375;

  const range = ticker.highPrice24h - ticker.lowPrice24h;
  const rangePercent = ticker.price > 0 ? (range / ticker.price) * 100 : 0;
  const rangeScore = Math.min(rangePercent * 3, 20);

  const positionInRange = range > 0 ? (ticker.price - ticker.lowPrice24h) / range : 0.5;
  const momentumScore =
    positionInRange >= 0.5
      ? (positionInRange - 0.5) * 40 + 10
      : positionInRange * 20;

  return volumeScore + volatilityScore + rangeScore + momentumScore;
}
