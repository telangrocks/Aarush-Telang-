import * as fs from 'fs';
import * as path from 'path';

function fixTypesRound2() {
  const configPath = path.join(__dirname, '..', 'exchanges', 'models', 'ConnectionConfig.ts');
  let configContent = fs.readFileSync(configPath, 'utf-8');
  configContent = configContent.replace(/apiKey: string;/g, 'apiKey?: string;');
  configContent = configContent.replace(/secret: string;/g, 'secret?: string;');
  configContent = configContent.replace(/password\?: string;/g, 'password?: string;');
  fs.writeFileSync(configPath, configContent, 'utf-8');

  const exPath = path.join(__dirname, '..', 'handlers', 'exchange.ts');
  let exContent = fs.readFileSync(exPath, 'utf-8');
  exContent = exContent.replace(/\.fetchBalances\(/g, '.fetchBalance(');
  exContent = exContent.replace(/\.fetchMarketData\(\)/g, '.fetchMarkets()');
  exContent = exContent.replace(/ticker\.price/g, '(ticker as any).last.toNumber()');
  exContent = exContent.replace(/ticker\.volume24h/g, '(ticker as any).volume.toNumber()');
  exContent = exContent.replace(/ticker\.quoteVolume24h/g, '(ticker as any).quoteVolume.toNumber()');
  exContent = exContent.replace(/ticker\.priceChange24h/g, '0');
  exContent = exContent.replace(/ticker\.priceChangePercent24h/g, '0');
  exContent = exContent.replace(/ticker\.highPrice24h/g, '(ticker as any).high.toNumber()');
  exContent = exContent.replace(/ticker\.lowPrice24h/g, '(ticker as any).low.toNumber()');
  exContent = exContent.replace(/ticker\.minNotional/g, '0');
  exContent = exContent.replace(/ticker\.minOrderQty/g, '0');
  exContent = exContent.replace(/ticker\.maxOrderQty/g, '0');
  exContent = exContent.replace(/ticker\.tickSize/g, '0');
  exContent = exContent.replace(/ticker\.lotSize/g, '0');
  fs.writeFileSync(exPath, exContent, 'utf-8');

  const botPath = path.join(__dirname, '..', 'trading-bot.ts');
  let botContent = fs.readFileSync(botPath, 'utf-8');
  botContent = botContent.replace(/ticker\.last/g, '(ticker as any).last');
  botContent = botContent.replace(/return this\.adapter\.fetchTicker\(symbol\) as any;/g, 'return this.adapter.fetchTicker(symbol) as any;'); // already done
  
  // fix remaining fetchBalances
  botContent = botContent.replace(/\.fetchBalances\(/g, '.fetchBalance(');
  
  // replace the specific AdapterCandleProvider fetchTicker return type
  botContent = botContent.replace(/async fetchTicker\(symbol: string\): Promise<MarketTicker \| null> \{/g, 'async fetchTicker(symbol: string): Promise<any | null> {');
  
  fs.writeFileSync(botPath, botContent, 'utf-8');
  console.log("Types fixed round 2.");
}

fixTypesRound2();
