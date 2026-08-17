const https = require("https");

function fetchTickers(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    https.get("https://api.bybit.com/v5/market/tickers?category=linear", (res: any) => {
      let data = "";
      res.on("data", (chunk: any) => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data).result.list);
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function run() {
  const rawTickers: any[] = await fetchTickers();

  const MIN_VOLUME_USDT = 500_000;
  const MAX_DECLINE_PERCENT = -50;
  const STABLECOINS = ["USDT", "USDC", "BUSD", "TUSD", "FDUSD", "DAI", "USDP"];

  const filtered = rawTickers.filter((t: any) => {
    const vol = Number(t.turnover24h || t.volume24h || 1_000_000);
    const change = Number(t.price24hPcnt || 0) * 100;
    return vol >= MIN_VOLUME_USDT && change >= MAX_DECLINE_PERCENT && !STABLECOINS.includes(t.symbol);
  });

  function calculateOldScore(ticker: any): number {
    const volume = Number(ticker.turnover24h || ticker.volume24h || 0);
    const volumeScore = Math.min(Math.log10(volume + 1) * 5, 30);
    const changePercent = Number(ticker.price24hPcnt || 0) * 100;
    const volatility = Math.abs(changePercent);
    const volatilityScore = Math.min(volatility * 3, 30);
    const price = Number(ticker.lastPrice || 0);
    const high = Number(ticker.highPrice24h || price || 0);
    const low = Number(ticker.lowPrice24h || price || 0);
    const range = Math.max(0, high - low);
    const rangePercent = price > 0 ? (range / price) * 100 : 0;
    const rangeScore = Math.min(rangePercent * 3, 20);
    const momentumScore = Math.min(Math.abs(changePercent) * 3, 30);
    const trendDirectionScore = Math.max(-40, Math.min(40, changePercent * 4));
    const total = volumeScore + volatilityScore + rangeScore + momentumScore + trendDirectionScore;
    return isNaN(total) ? 0 : total;
  }

  function calculateNewScore(ticker: any): number {
    const volume = Number(ticker.turnover24h || ticker.volume24h || 0);
    const logVol = Math.max(0, Math.log10(volume + 1));
    const volumeScore = 30 * (1 - Math.exp(-logVol / 3));

    const changePercent = Number(ticker.price24hPcnt || 0) * 100;
    const volatility = Math.abs(changePercent);
    const volatilityScore = 30 * (1 - Math.exp(-volatility / 10));

    const price = Number(ticker.lastPrice || 0);
    const high = Number(ticker.highPrice24h || price || 0);
    const low = Number(ticker.lowPrice24h || price || 0);
    const range = Math.max(0, high - low);
    const rangePercent = price > 0 ? (range / price) * 100 : 0;
    const rangeScore = 20 * (1 - Math.exp(-rangePercent / 10));

    const momentumScore = changePercent > 0 ? 30 * (1 - Math.exp(-changePercent / 10)) : 0;

    const trendBase = 40 * (1 - Math.exp(-Math.abs(changePercent) / 10));
    const trendDirectionScore = changePercent > 0 ? trendBase : -trendBase;

    let total = volumeScore + volatilityScore + rangeScore + momentumScore + trendDirectionScore;
    if (isNaN(total)) return 0;
    return Math.max(0, Math.min(150, total));
  }

  const oldResults = filtered.map((c: any) => ({
      symbol: c.symbol,
      change: Number(c.price24hPcnt || 0) * 100,
      vol: Number(c.turnover24h || c.volume24h || 0),
      score: calculateOldScore(c)
  })).sort((a: any, b: any) => b.score - a.score);

  const newResults = filtered.map((c: any) => ({
      symbol: c.symbol,
      change: Number(c.price24hPcnt || 0) * 100,
      vol: Number(c.turnover24h || c.volume24h || 0),
      score: calculateNewScore(c)
  })).sort((a: any, b: any) => b.score - a.score);

  const oldRanks = new Map<string, number>();
  oldResults.forEach((r: any, i: number) => oldRanks.set(r.symbol, i + 1));

  const newRanks = new Map<string, number>();
  newResults.forEach((r: any, i: number) => newRanks.set(r.symbol, i + 1));

  console.log("Symbol | 24h Change | Volume | Old Score | Old Rank | New Score | New Rank");
  console.log("---|---|---|---|---|---|---");
  for (let i = 0; i < 20; i++) {
    const sym = newResults[i].symbol;
    const oldR = oldResults.find((r: any) => r.symbol === sym)!;
    const newR = newResults[i];
    console.log(`${sym} | ${newR.change.toFixed(2)}% | $${Math.round(newR.vol/1000000)}M | ${oldR.score.toFixed(1)} | #${oldRanks.get(sym)} | ${newR.score.toFixed(1)} | #${newRanks.get(sym)}`);
  }
}

run().catch(console.error);
