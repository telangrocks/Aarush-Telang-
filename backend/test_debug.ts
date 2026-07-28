import { BinanceExchange } from "./src/exchanges/BinanceExchange.ts";
import { type MarketTicker } from "./src/exchanges/BaseExchange.ts";

// Helper functions from market-analysis.ts
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

function calculateScoreAndComponents(ticker: MarketTicker) {
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

  const finalScore = volumeScore + volatilityScore + rangeScore + momentumScore + trendDirectionScore;

  return {
      volumeScore,
      volatilityScore,
      rangeScore,
      momentumScore,
      trendDirectionScore,
      finalScore
  };
}

async function runDebug() {
    console.log("=== STARTING DETAILED DEBUG VALIDATION ===");
    const apiKey = "o1lGAij4iQDD2PDsOvCeBExnpTWXMDyAiboPAScolnw0feUD5dWOITa8GzyXAJe7";
    const apiSecret = "So9UBSv1Fcn89F1gY43U62p6NlzmaingQdnMpeLaGehq7xZrc5Fa78tEL7H28nzV";
    
    const exchange = new BinanceExchange("testnet", "global");
    
    // Validate
    await exchange.validateCredentials(apiKey, apiSecret);
    
    // Fetch Tickers
    const tickers = await exchange.fetchMarketData();
    
    // Filter and score (Pass 1)
    const MIN_VOLUME_USDT = 500_000;
    const MAX_DECLINE_PERCENT = -50;
    const filtered = tickers.filter(
        (t) => (t.quoteVolume24h || t.volume24h || 0) >= MIN_VOLUME_USDT && t.priceChangePercent24h >= MAX_DECLINE_PERCENT
    );
    
    const scored = filtered.map(t => ({ ticker: t, scoring: calculateScoreAndComponents(t) }));
    scored.sort((a, b) => b.scoring.finalScore - a.scoring.finalScore);
    
    // Top 3 for detailed debug so output isn't overwhelmingly huge for a single message
    // (We can do top 10 but let's do top 5 to keep it readable)
    const top10 = scored.slice(0, 10);
    
    for (let i = 0; i < top10.length; i++) {
        const item = top10[i];
        const sym = item.ticker.symbol;
        
        console.log(`\n========================================`);
        console.log(`RANK #${i+1}: ${sym}`);
        console.log(`========================================`);
        console.log(`Current Price: $${item.ticker.price}`);
        console.log(`24h Price Change: ${item.ticker.priceChangePercent24h}%`);
        
        console.log(`\n--- SCORING COMPONENTS ---`);
        console.log(`Volume Score:         ${item.scoring.volumeScore.toFixed(2)} (from $${item.ticker.quoteVolume24h.toFixed(2)} vol)`);
        console.log(`Volatility Score:     ${item.scoring.volatilityScore.toFixed(2)} (from ${Math.abs(item.ticker.priceChangePercent24h)}% abs change)`);
        console.log(`Range Score:          ${item.scoring.rangeScore.toFixed(2)} (High-Low spread)`);
        console.log(`Momentum Score:       ${item.scoring.momentumScore.toFixed(2)}`);
        console.log(`Trend Direction Score:${item.scoring.trendDirectionScore.toFixed(2)}`);
        console.log(`----------------------------------------`);
        console.log(`FINAL TIER SCORE:     ${item.scoring.finalScore.toFixed(2)}`);
        
        // Fetch Klines
        const klines1h = await exchange.fetchKlines(sym, "1h", 60); // fetch more for accurate EMA
        if (klines1h.length < 50) {
            console.log(`Not enough klines for ${sym}. Skipping timeframe analysis.`);
            continue;
        }
        
        const closes = klines1h.map(k => k.close);
        const ema20 = calculateEMA(closes, 20);
        const ema50 = calculateEMA(closes, 50);
        const rsi = calculateRSI(closes, 14);
        
        let decision = "HOLD";
        let reason = "";
        
        if (ema20 > ema50 && rsi > 50) {
            decision = "BUY";
            reason = "EMA20 is ABOVE EMA50 (Bullish Trend) AND RSI is > 50 (Bullish Momentum).";
        } else if (ema20 < ema50 && rsi < 50) {
            decision = "SELL";
            reason = "EMA20 is BELOW EMA50 (Bearish Trend) AND RSI is < 50 (Bearish Momentum).";
        } else {
            reason = "Indicators are mixed. EMA20/50 cross and RSI do not align.";
        }
        
        console.log(`\n--- TECHNICAL INDICATORS (1h Timeframe) ---`);
        console.log(`EMA 20: ${ema20.toFixed(5)}`);
        console.log(`EMA 50: ${ema50.toFixed(5)}`);
        console.log(`RSI 14: ${rsi.toFixed(2)}`);
        console.log(`MACD:   Not currently used in the bot's strategy.`);
        
        console.log(`\n--- FINAL DECISION (1h) ---`);
        console.log(`Decision: ${decision}`);
        console.log(`Reason:   ${reason}`);
    }
}

runDebug();
