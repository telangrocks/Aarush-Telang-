import * as fs from 'fs';
import * as path from 'path';

function refactorTradingBot() {
  const filePath = path.join(__dirname, '..', 'trading-bot.ts');
  let content = fs.readFileSync(filePath, 'utf-8');

  // 1. Imports
  content = content.replace(
    /import { getExchangeAdapter, ExchangeName, ExchangeEnvironment, ExchangeRegion, MarketTicker, IExchangeAdapter } from '\.\/exchanges';/g,
    `import { ExchangeManager, ExchangeName, ExchangeEnvironment, ExchangeRegion, IExchangeProvider } from './exchanges';\nimport type { MarketTicker } from './exchanges/BaseExchange';`
  );
  
  // 2. AdapterCandleProvider
  content = content.replace(
    /class AdapterCandleProvider implements ICandleProvider \{\n  constructor\(private adapter: IExchangeAdapter\) \{\}\n\n  async fetchCandles\(symbol: string, timeframe: Timeframe, limit: number = 100\): Promise<NormalizedCandle\[\]> \{\n.*?\n    const klines = await this\.adapter\.fetchKlines\(symbol, timeframe, limit\);\n    return klines\.map\(\(k: Kline\) => \(\{\n      timestamp: k\.openTime,\n      open: k\.open,\n      high: k\.high,\n      low: k\.low,\n      close: k\.close,\n      volume: k\.volume\n    \}\)\);\n  \}\n\n  async fetchTicker\(symbol: string\): Promise<MarketTicker \| null> \{\n    return this\.adapter\.fetchTicker\(symbol\) as any;\n  \}\n\}/s,
    `class AdapterCandleProvider implements ICandleProvider {
  constructor(private adapter: IExchangeProvider) {}

  async fetchCandles(symbol: string, timeframe: Timeframe, limit: number = 100): Promise<NormalizedCandle[]> {
    const klines = await this.adapter.fetchKlines(symbol, timeframe, limit);
    return klines.map((k: any) => ({
      timestamp: k.openTime,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume
    }));
  }

  async fetchTicker(symbol: string): Promise<MarketTicker | null> {
    return this.adapter.fetchTicker(symbol) as any;
  }
}`
  );

  // 3. Replace adapter initialization
  content = content.replace(
    /const adapter = getExchangeAdapter\(([^,]+), normalizeEnvironment\(([^)]+)\), normalizeRegion\(([^)]+)\)\);/g,
    `const adapter = await ExchangeManager.getProvider($1, { environment: normalizeEnvironment($2) });`
  );

  content = content.replace(
    /const adapter = user\?\.exchange_name \? getExchangeAdapter\(user\.exchange_name as ExchangeName, normalizeEnvironment\(user\.exchange_environment\), normalizeRegion\(user\.exchange_region\)\) : null;/g,
    `const adapter = user?.exchange_name ? await ExchangeManager.getProvider(user.exchange_name, { environment: normalizeEnvironment(user.exchange_environment) }) : null;`
  );

  content = content.replace(
    /const adapter = userKeys\?\.exchange_name \? await getExchangeAdapter\(userKeys\.exchange_name as ExchangeName, normalizeEnvironment\(userKeys\.exchange_environment\), normalizeRegion\(userKeys\.exchange_region\)\) : null;/g,
    `const adapter = userKeys?.exchange_name ? await ExchangeManager.getProvider(userKeys.exchange_name, { environment: normalizeEnvironment(userKeys.exchange_environment) }) : null;`
  );

  content = content.replace(
    /const ticker = user\?\.exchange_name \? await getExchangeAdapter\(user\.exchange_name as ExchangeName, normalizeEnvironment\(user\.exchange_environment\), normalizeRegion\(user\.exchange_region\)\)\.fetchTicker\(coinId\)\.catch\(\(\) => null\) : null;/g,
    `const ticker = user?.exchange_name ? await (await ExchangeManager.getProvider(user.exchange_name, { environment: normalizeEnvironment(user.exchange_environment) })).fetchTicker(coinId).catch(() => null) : null;`
  );

  // 4. Replace order placement logic
  // Since order placement spans multiple lines, we'll replace the block.
  content = content.replace(
    /if \(adapter\.placeOrder\) \{[\s\S]*?orderResult = await adapter\.placeOrder\([\s\S]*?\);[\s\S]*?\} catch \(e: any\) \{/gm,
    `if (adapter) {
                const ticker = await adapter.fetchTicker(orderSymbol);
                const currentPrice = ticker?.last?.toNumber() || target.signalPrice || target.entryPrice;
                const targetPrice = target.targetEntryPrice || target.signalPrice || target.entryPrice;
                
                const deltaPercent = currentPrice > 0 ? (Math.abs(targetPrice - currentPrice) / currentPrice) : 0;
                if (target.targetEntryPrice && deltaPercent > 0.0005) {
                  orderType = 'LIMIT';
                  limitPrice = target.targetEntryPrice;
                }

                const refPrice = limitPrice || currentPrice;
                const rulesRes = TradeValidator.validate({
                  symbol: orderSymbol,
                  entryPrice: refPrice,
                  tradeValueUsdt: target.positionSize
                }, ticker ? {
                  schemaVersion: "2.0",
                  symbol: ticker.symbol,
                  exchange: userKeys.exchange_name || "binance",
                  baseAsset: ticker.symbol,
                  quoteAsset: "USDT",
                  minNotional: 0,
                  minQty: 0,
                  maxQty: 999999,
                  stepSize: 0,
                  tickSize: 0,
                  minPrice: 0,
                  maxPrice: 999999999,
                  contractSize: 1,
                  lastUpdated: Date.now()
                } : null);

                if (!rulesRes.isValid) {
                  throw new Error(rulesRes.errorMessage || \`Order validation failed: \${rulesRes.errorCode}\`);
                }

                const qty = rulesRes.quantizedQuantity;
                
                // Re-fetch provider with full keys for write
                const writeProvider = await ExchangeManager.getProvider(userKeys.exchange_name, {
                   environment: normalizeEnvironment(userKeys.exchange_environment),
                   apiKey: userKeys.exchange_api_key,
                   secret: decryptedSecret,
                   password: decryptedPassphrase
                });

                const req: any = {
                   symbol: orderSymbol,
                   side: side.toLowerCase(),
                   type: orderType.toLowerCase(),
                   amount: new (require('bignumber.js').default)(qty),
                   clientOrderId: clientOrderId,
                   params: {}
                };
                if (limitPrice) req.price = new (require('bignumber.js').default)(limitPrice);
                if (target.stopLoss) req.params.stopLossPrice = target.stopLoss;
                if (target.takeProfit) req.params.takeProfitPrice = target.takeProfit;

                const rawOrder = await ExchangeManager.executeIdempotentOrder(writeProvider, req);
                orderResult = {
                   success: true,
                   orderId: rawOrder.id,
                   price: rawOrder.average?.toNumber() || rawOrder.price?.toNumber(),
                   quantity: rawOrder.filled?.toNumber() || rawOrder.amount.toNumber(),
                   status: rawOrder.status === 'open' ? 'open' : 'filled'
                };
              }
            } catch (e: any) {`
  );

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log("trading-bot.ts refactored.");
}

function refactorExchangeHandlers() {
  const filePath = path.join(__dirname, '..', 'handlers', 'exchange.ts');
  let content = fs.readFileSync(filePath, 'utf-8');

  content = content.replace(
    /import \{ getExchangeAdapter, ExchangeName, ExchangeEnvironment, ExchangeRegion \} from "\.\.\/exchanges";/g,
    `import { ExchangeManager, ExchangeName, ExchangeEnvironment, ExchangeRegion } from "../exchanges";`
  );

  // Replace adapter = getExchangeAdapter(...) with ExchangeManager.getProvider
  // Note: handlers/exchange.ts has many validation calls like adapter.validateCredentials
  // We need to route those through CcxtProvider too? Or just skip them?
  // Wait, the legacy exchange adapters have \`validateCredentials\`. The CCXT layer handles it natively during connect().
  // Let's replace validation logic directly.
  
  content = content.replace(
    /const adapter = getExchangeAdapter\(exchangeName, normalizeEnvironment\(environment\), region\);\n\s+const result = await adapter\.validateCredentials\(cleanApiKey, cleanApiSecret, cleanApiPassphrase\);/g,
    `const provider = await ExchangeManager.getProvider(exchangeName, {
      environment: normalizeEnvironment(environment),
      apiKey: cleanApiKey,
      secret: cleanApiSecret,
      password: cleanApiPassphrase
    });
    
    let result = { success: true, message: 'OK' };
    try {
      await provider.fetchBalance();
    } catch (e: any) {
      result = { success: false, message: e.message };
    }`
  );
  
  content = content.replace(
    /const adapter = getExchangeAdapter\(exchangeName, resolvedEnvironment, region\);\n\s+const validation = await adapter\.validateCredentials\(cleanApiKey, cleanApiSecret, cleanApiPassphrase\);/g,
    `const provider = await ExchangeManager.getProvider(exchangeName, {
      environment: resolvedEnvironment,
      apiKey: cleanApiKey,
      secret: cleanApiSecret,
      password: cleanApiPassphrase
    });
    
    let validation = { success: true, message: 'OK' };
    try {
      await provider.fetchBalance();
    } catch (e: any) {
      validation = { success: false, message: e.message };
    }`
  );

  content = content.replace(
    /const adapter = getExchangeAdapter\(user\.exchange_name as ExchangeName, environment, region\);\n\n\s+if \(!adapter\.fetchBalances\) \{[\s\S]*?\}\n\n\s+const balanceRes = await adapter\.fetchBalances\(user\.exchange_api_key, decryptedSecret, decryptedPassphrase\);/g,
    `const provider = await ExchangeManager.getProvider(user.exchange_name, {
      environment,
      apiKey: user.exchange_api_key,
      secret: decryptedSecret,
      password: decryptedPassphrase
    });
    
    const balances = await provider.fetchBalance();
    const balanceRes = {
      success: true,
      exchange: user.exchange_name,
      environment,
      primaryAsset: "USDT",
      balances: balances.map(b => ({
        asset: b.currency,
        free: b.free.toNumber(),
        locked: b.used.toNumber(),
        total: b.total.toNumber()
      }))
    };`
  );

  content = content.replace(
    /const adapter = getExchangeAdapter\(user\.exchange_name as ExchangeName, normalizeEnvironment\(user\.exchange_environment\), normalizeRegion\(user\.exchange_region\)\);\n\s+const tickers = await adapter\.fetchMarketData\(\);/g,
    `const provider = await ExchangeManager.getProvider(user.exchange_name, {
      environment: normalizeEnvironment(user.exchange_environment)
    });
    // Temporary shim for analyzeMarket expectations
    const markets = await provider.fetchMarkets();
    const tickers = markets.map(m => ({ symbol: m.symbol }));
    const adapter = provider as any;`
  );

  content = content.replace(
    /const adapter = getExchangeAdapter\(user\.exchange_name as ExchangeName, normalizeEnvironment\(user\.exchange_environment\), normalizeRegion\(user\.exchange_region\)\);\n\s+const ticker = await adapter\.fetchTicker\(symbol\);/g,
    `const provider = await ExchangeManager.getProvider(user.exchange_name, {
      environment: normalizeEnvironment(user.exchange_environment)
    });
    const ccxtTicker = await provider.fetchTicker(symbol).catch(() => null);
    const ticker = ccxtTicker ? {
      symbol: ccxtTicker.symbol,
      price: ccxtTicker.last.toNumber(),
      volume24h: ccxtTicker.volume.toNumber(),
      quoteVolume24h: ccxtTicker.quoteVolume.toNumber(),
      priceChange24h: 0,
      priceChangePercent24h: 0,
      highPrice24h: ccxtTicker.high.toNumber(),
      lowPrice24h: ccxtTicker.low.toNumber(),
      minNotional: 0,
      minOrderQty: 0,
      maxOrderQty: 0,
      tickSize: 0,
      lotSize: 0
    } : null;`
  );
  
  content = content.replace(
    /const adapter = getExchangeAdapter\(user\.exchange_name as ExchangeName, normalizeEnvironment\(user\.exchange_environment\), normalizeRegion\(user\.exchange_region\)\);\n\s+const klines = await adapter\.fetchKlines\(symbol, interval, limit\);/g,
    `const provider = await ExchangeManager.getProvider(user.exchange_name, {
      environment: normalizeEnvironment(user.exchange_environment)
    });
    const klines = await provider.fetchKlines(symbol, interval, limit);`
  );

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log("exchange.ts refactored.");
}

refactorTradingBot();
refactorExchangeHandlers();
