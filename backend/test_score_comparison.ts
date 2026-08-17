

// We need some candidate data
const testCandidates = [
  { symbol: "BTCUSDT", volume24h: 3000000000, priceChangePercent24h: 2.5, price: 60000, highPrice24h: 62000, lowPrice24h: 59000 },
  { symbol: "ETHUSDT", volume24h: 1500000000, priceChangePercent24h: 4.0, price: 3000, highPrice24h: 3150, lowPrice24h: 2950 },
  { symbol: "SOLUSDT", volume24h: 500000000, priceChangePercent24h: 11.0, price: 150, highPrice24h: 160, lowPrice24h: 130 },
  { symbol: "DOGEUSDT", volume24h: 400000000, priceChangePercent24h: -15.0, price: 0.1, highPrice24h: 0.12, lowPrice24h: 0.09 },
  { symbol: "WIFUSDT", volume24h: 80000000, priceChangePercent24h: 25.0, price: 2.0, highPrice24h: 2.2, lowPrice24h: 1.5 },
  { symbol: "PEPEUSDT", volume24h: 120000000, priceChangePercent24h: 12.0, price: 0.00001, highPrice24h: 0.000012, lowPrice24h: 0.000008 },
  { symbol: "BNBUSDT", volume24h: 600000000, priceChangePercent24h: 1.0, price: 550, highPrice24h: 560, lowPrice24h: 540 },
  { symbol: "ADAUSDT", volume24h: 150000000, priceChangePercent24h: 0.5, price: 0.45, highPrice24h: 0.46, lowPrice24h: 0.44 },
  { symbol: "XRPUSDT", volume24h: 300000000, priceChangePercent24h: 8.0, price: 0.60, highPrice24h: 0.65, lowPrice24h: 0.55 },
  { symbol: "AVAXUSDT", volume24h: 200000000, priceChangePercent24h: 16.0, price: 35, highPrice24h: 38, lowPrice24h: 28 },
  { symbol: "LINKUSDT", volume24h: 100000000, priceChangePercent24h: 9.0, price: 18, highPrice24h: 20, lowPrice24h: 16 },
  { symbol: "NEARUSDT", volume24h: 150000000, priceChangePercent24h: -5.0, price: 6, highPrice24h: 6.5, lowPrice24h: 5.8 }
];

function calculateOldScore(ticker: any): number {
  const volume = Number(ticker.quoteVolume24h || ticker.volume24h || 0);
  const volumeScore = Math.min(Math.log10(volume + 1) * 5, 30);

  const volatility = Math.abs(Number(ticker.priceChangePercent24h || 0));
  const volatilityScore = Math.min(volatility * 3, 30);

  const price = Number(ticker.price || 0);
  const high = Number(ticker.highPrice24h || price || 0);
  const low = Number(ticker.lowPrice24h || price || 0);
  const range = Math.max(0, high - low);
  const rangePercent = price > 0 ? (range / price) * 100 : 0;
  const rangeScore = Math.min(rangePercent * 3, 20);

  const changePercent = Number(ticker.priceChangePercent24h || 0);
  const momentumScore = Math.min(Math.abs(changePercent) * 3, 30);
  const trendDirectionScore = Math.max(-40, Math.min(40, changePercent * 4));

  const total = volumeScore + volatilityScore + rangeScore + momentumScore + trendDirectionScore;
  return isNaN(total) ? 0 : total;
}

function calculateNewScore(ticker: any): number {
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

  const total = volumeScore + volatilityScore + rangeScore + momentumScore + trendDirectionScore;
  return isNaN(total) ? 0 : total;
}

const oldResults = testCandidates.map(c => ({
    symbol: c.symbol,
    score: calculateOldScore(c),
    change: c.priceChangePercent24h
})).sort((a, b) => b.score - a.score);

const newResults = testCandidates.map(c => ({
    symbol: c.symbol,
    score: calculateNewScore(c),
    change: c.priceChangePercent24h
})).sort((a, b) => b.score - a.score);

console.log("OLD RANKING (0-150):");
oldResults.forEach((r, i) => console.log(`${i+1}. ${r.symbol}: ${r.score.toFixed(1)} (Change: ${r.change}%)`));

console.log("\nNEW RANKING (0-150):");
newResults.forEach((r, i) => console.log(`${i+1}. ${r.symbol}: ${r.score.toFixed(1)} (Change: ${r.change}%)`));
