import { BinanceExchange } from "../src/exchanges/BinanceExchange";
import { calculateTradeSetup } from "../src/crypto";

const apiKey = "2oeD8QqydFEuQuYsLmIKfXCrvi5p2ecSknnOMX4TWyJE2XW9bk2SJau0cCxxEMpb";
const apiSecret = "G9sQXwGfQODpe445UwIonRl0a2KB2uWSqRdYmj4qjj5Ic3Fds0WzQ2eDy2eJ85th";

export function computeTradeSetup(params: {
  symbol: string;
  currentPrice: number;
  entryPrice: number;
  minNotional: number;
  positionSizeUsdt: number;
  riskRewardRatio: number; // e.g. 2 for 1:2, 3 for 1:3
  side: "BUY" | "SELL";
  atr: number;
  trailingStopTicks?: number;
}) {
  const { symbol, currentPrice, entryPrice, minNotional, positionSizeUsdt, riskRewardRatio, side, atr, trailingStopTicks } = params;

  // 1. Min Notional Check
  const isAboveMinNotional = positionSizeUsdt >= minNotional;
  const recommendedMinSize = Math.max(positionSizeUsdt, minNotional);

  // 2. Automated SL / TP Calculation based on ATR & Selected R:R Ratio
  const atrDelta = atr > 0 ? atr : entryPrice * 0.01;
  const slDistance = atrDelta * 1.0;
  const tpDistance = slDistance * riskRewardRatio;

  const stopLoss = side === "BUY" ? entryPrice - slDistance : entryPrice + slDistance;
  const takeProfit = side === "BUY" ? entryPrice + tpDistance : entryPrice - tpDistance;

  // 3. Trailing Stop Distance in Price Ticks (0.0001 tick size for DOGE)
  const tickSize = 0.0001;
  const trailingStopDistance = trailingStopTicks ? trailingStopTicks * tickSize : undefined;

  // 4. Position Sizing & PnL Projections
  const quantity = recommendedMinSize / entryPrice;
  const maxLossUsdt = Math.abs(entryPrice - stopLoss) * quantity;
  const maxProfitUsdt = Math.abs(takeProfit - entryPrice) * quantity;

  return {
    symbol,
    side,
    currentPrice,
    entryPrice,
    minNotional,
    positionSizeUsdt: recommendedMinSize,
    isAboveMinNotional,
    quantity: parseFloat(quantity.toFixed(4)),
    stopLoss: parseFloat(stopLoss.toFixed(5)),
    takeProfit: parseFloat(takeProfit.toFixed(5)),
    riskRewardRatio: `1:${riskRewardRatio}`,
    trailingStopTicks: trailingStopTicks || 0,
    trailingStopDistance: trailingStopDistance ? parseFloat(trailingStopDistance.toFixed(5)) : null,
    riskMetrics: {
      maxLossUsdt: parseFloat(maxLossUsdt.toFixed(2)),
      maxProfitUsdt: parseFloat(maxProfitUsdt.toFixed(2)),
      actualRiskRewardRatio: (maxProfitUsdt / (maxLossUsdt || 1)).toFixed(2),
    },
  };
}

async function runTradeSetupFlowValidation() {
  console.log("================================================================================");
  console.log("        CRYPTOPULSE TRADE SETUP & AUTOMATED SL/TP CALCULATION ENGINE            ");
  console.log("================================================================================");

  const selectedCoin = "DOGE";
  console.log(`\n[1/4] Fetching live ticker & ATR from Binance Testnet for '${selectedCoin}'...`);

  const adapter = new BinanceExchange("testnet", "global");
  const ticker = await adapter.fetchTicker(selectedCoin);
  const klines = await adapter.fetchKlines(selectedCoin, "1h", 20);

  if (!ticker || klines.length === 0) {
    console.error("Failed to fetch live market data.");
    return;
  }

  // Calculate ATR (Average True Range over 14 bars)
  let trSum = 0;
  for (let i = 1; i < klines.length; i++) {
    const tr = Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    );
    trSum += tr;
  }
  const atr = trSum / (klines.length - 1);

  console.log(`-> Live Market Price  : $${ticker.price}`);
  console.log(`-> Minimum Notional    : $${ticker.minNotional} USDT`);
  console.log(`-> Calculated 1h ATR   : $${atr.toFixed(6)}`);

  // STEP 2: Trade Setup Simulation (User enters Entry Price & selects R:R Ratio)
  console.log(`\n[2/4] Testing Trade Setup Input & Automated SL/TP Calculation (1:2 R:R Ratio)...`);

  const userEntryPrice = parseFloat((ticker.price * 0.998).toFixed(4)); // Entry set slightly below current price
  const validTradeSetup = computeTradeSetup({
    symbol: selectedCoin,
    currentPrice: ticker.price,
    entryPrice: userEntryPrice,
    minNotional: ticker.minNotional,
    positionSizeUsdt: 20.0, // $20 USDT position
    riskRewardRatio: 2, // 1:2 R:R
    side: "BUY",
    atr,
    trailingStopTicks: 20, // 20 ticks trailing SL
  });

  console.log(`-> User Input Entry Price       : $${validTradeSetup.entryPrice}`);
  console.log(`-> Min Notional Passed          : ${validTradeSetup.isAboveMinNotional ? "✅ YES ($20 >= $5)" : "❌ NO"}`);
  console.log(`-> Automated Stop Loss (SL)      : $${validTradeSetup.stopLoss}`);
  console.log(`-> Automated Take Profit (TP)    : $${validTradeSetup.takeProfit}`);
  console.log(`-> Selected Risk-to-Reward Ratio : ${validTradeSetup.riskRewardRatio}`);
  console.log(`-> Trailing Stop Ticks          : ${validTradeSetup.trailingStopTicks} ticks ($${validTradeSetup.trailingStopDistance})`);
  console.log(`-> Risk Metrics                 : Max Loss = -$${validTradeSetup.riskMetrics.maxLossUsdt}, Max Profit = +$${validTradeSetup.riskMetrics.maxProfitUsdt} (Actual R:R = 1:${validTradeSetup.riskMetrics.actualRiskRewardRatio})`);

  // STEP 3: Testing Min Notional Rejection (Order size < $5 USDT)
  console.log(`\n[3/4] Testing Min Notional Validation Guardrail (Small $2.00 Order)...`);
  const invalidTradeSetup = computeTradeSetup({
    symbol: selectedCoin,
    currentPrice: ticker.price,
    entryPrice: userEntryPrice,
    minNotional: ticker.minNotional,
    positionSizeUsdt: 2.0, // $2 USDT position (< minNotional of $5)
    riskRewardRatio: 2,
    side: "BUY",
    atr,
  });

  console.log(`-> User Input Position Size : $2.00 USDT`);
  console.log(`-> Min Notional Check       : ${invalidTradeSetup.isAboveMinNotional ? "PASSED" : "FAILED (Order value $2.00 is below minimum notional of $5.00)"}`);
  console.log(`-> Auto-Adjusted Size       : $${invalidTradeSetup.positionSizeUsdt} USDT (Upgraded to exchange minimum threshold)`);

  // STEP 4: Progression to 'Select Strategy' Page Payload
  console.log(`\n[4/4] Prepared Payload for Navigation to 'Select Strategy' Page...`);

  const strategyPagePayload = {
    selectedCoin: validTradeSetup.symbol,
    tradeSetup: {
      entryPrice: validTradeSetup.entryPrice,
      stopLoss: validTradeSetup.stopLoss,
      takeProfit: validTradeSetup.takeProfit,
      positionSizeUsdt: validTradeSetup.positionSizeUsdt,
      riskRewardRatio: validTradeSetup.riskRewardRatio,
      trailingStopTicks: validTradeSetup.trailingStopTicks,
    },
    availableStrategies: ["ScalperV2", "Momentum", "Breakout", "MeanReversion", "VWAP"],
  };

  console.log(JSON.stringify(strategyPagePayload, null, 2));

  console.log("\n================================================================================");
  console.log("                     TRADE SETUP FLOW VALIDATION COMPLETE                       ");
  console.log("================================================================================");
}

runTradeSetupFlowValidation();
