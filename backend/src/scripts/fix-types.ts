import * as fs from 'fs';
import * as path from 'path';

function fixTypes() {
  // Fix ProviderConfig environment
  const pPath = path.join(__dirname, '..', 'exchanges', 'models', 'ConnectionConfig.ts');
  let pContent = fs.readFileSync(pPath, 'utf-8');
  pContent = pContent.replace(
    /environment: 'Production' \| 'Testing';/,
    `environment: 'Production' | 'Testing' | 'mainnet' | 'testnet';`
  );
  fs.writeFileSync(pPath, pContent, 'utf-8');

  // Fix IExchangeAdapter missing in trading-bot.ts
  const botPath = path.join(__dirname, '..', 'trading-bot.ts');
  let botContent = fs.readFileSync(botPath, 'utf-8');
  botContent = botContent.replace(/IExchangeAdapter/g, 'IExchangeProvider');
  botContent = botContent.replace(/ticker\?\.price/g, 'ticker?.last?.toNumber()');
  botContent = botContent.replace(/ticker\.price/g, 'ticker.last.toNumber()');
  botContent = botContent.replace(/ccxtTicker\.last\.toNumber\(\)\.toNumber\(\)/g, 'ccxtTicker.last.toNumber()'); // avoid double replace issues
  
  // Also we missed some getExchangeAdapter calls because they span multiple lines or different spacing
  botContent = botContent.replace(/getExchangeAdapter\([\s\S]*?\)/g, (match) => {
    // If it's the import, ignore
    if (match.includes('import')) return match;
    // We already replaced most, but the remaining might look like:
    // getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region))
    // We can just convert it to:
    // (await ExchangeManager.getProvider(user.exchange_name, { environment: normalizeEnvironment(user.exchange_environment) }))
    
    // Extract the first two arguments
    const m = match.match(/getExchangeAdapter\(([^,]+),\s*([^,]+)(?:,\s*([^)]+))?\)/);
    if (m) {
      return `(await ExchangeManager.getProvider(${m[1]}, { environment: ${m[2]} }))`;
    }
    return match;
  });

  fs.writeFileSync(botPath, botContent, 'utf-8');

  // Fix exchange.ts
  const exPath = path.join(__dirname, '..', 'handlers', 'exchange.ts');
  let exContent = fs.readFileSync(exPath, 'utf-8');
  
  // Any remaining getExchangeAdapter
  exContent = exContent.replace(/getExchangeAdapter\(([^,]+),\s*([^,]+)(?:,\s*([^)]+))?\)/g, 
    `(await ExchangeManager.getProvider($1, { environment: $2 }))`);
    
  exContent = exContent.replace(/a\.volume24h - b\.volume24h/g, '(a as any).volume24h - (b as any).volume24h');

  fs.writeFileSync(exPath, exContent, 'utf-8');
  console.log("Types fixed.");
}

fixTypes();
