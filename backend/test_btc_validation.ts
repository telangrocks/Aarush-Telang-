import { BinanceExchange } from "./src/exchanges/BinanceExchange.ts";

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

async function runBtcValidation() {
    console.log("=== BTCUSDT SPOT TESTNET VALIDATION (1h) ===\n");
    
    const exchange = new BinanceExchange("testnet", "global");
    
    // Fetch 500 candles so EMAs match Binance Charts
    console.log("Fetching 500 1h candles for BTCUSDT...");
    const klines = await exchange.fetchKlines("BTC", "1h", 500);
    
    if (klines.length === 0) {
        console.log("Failed to fetch klines.");
        return;
    }
    
    console.log(`Successfully fetched ${klines.length} candles.\n`);
    
    const closes = klines.map(k => k.close);
    
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const rsi14 = calculateRSI(closes, 14);
    
    console.log(`--- LAST 60 OHLCV CANDLES ---`);
    console.log(`OpenTime | Open | High | Low | Close | Volume`);
    const last60 = klines.slice(-60);
    last60.forEach(k => {
        const d = new Date(k.openTime).toISOString().replace("T", " ").substring(0, 19);
        console.log(`${d} | ${k.open} | ${k.high} | ${k.low} | ${k.close} | ${k.volume}`);
    });
    
    console.log(`\n--- CALCULATED INDICATORS ---`);
    console.log(`EMA 20: ${ema20.toFixed(2)}`);
    console.log(`EMA 50: ${ema50.toFixed(2)}`);
    console.log(`RSI 14: ${rsi14.toFixed(2)}`);
    
    let decision = "HOLD";
    if (ema20 > ema50 && rsi14 > 50) decision = "BUY";
    else if (ema20 < ema50 && rsi14 < 50) decision = "SELL";
    
    console.log(`\n--- BOT DECISION ---`);
    console.log(`Final Decision: ${decision}`);
    
    if (decision === "BUY") console.log(`Reason: EMA20 (${ema20.toFixed(2)}) > EMA50 (${ema50.toFixed(2)}) AND RSI (${rsi14.toFixed(2)}) > 50`);
    else if (decision === "SELL") console.log(`Reason: EMA20 (${ema20.toFixed(2)}) < EMA50 (${ema50.toFixed(2)}) AND RSI (${rsi14.toFixed(2)}) < 50`);
    else console.log(`Reason: Mixed signals.`);
}

runBtcValidation();
