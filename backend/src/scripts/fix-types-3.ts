import * as fs from 'fs';
import * as path from 'path';

function fixTypesRound3() {
  const exPath = path.join(__dirname, '..', 'handlers', 'exchange.ts');
  let exContent = fs.readFileSync(exPath, 'utf-8');
  
  // Fix validateCredentials
  exContent = exContent.replace(/const result = await adapter\.validateCredentials\([\s\S]*?\);/g, `
    let result = { success: true, message: 'OK' };
    try { await adapter.fetchBalance(); } catch(e:any) { result = { success: false, message: e.message }; }
  `);
  exContent = exContent.replace(/const validation = await adapter\.validateCredentials\([\s\S]*?\);/g, `
    let validation = { success: true, message: 'OK' };
    try { await adapter.fetchBalance(); } catch(e:any) { validation = { success: false, message: e.message }; }
  `);
  
  exContent = exContent.replace(/adapter\.config\.environment/g, 'environment');
  
  exContent = exContent.replace(/\.fetchBalances\(/g, '.fetchBalance(');
  exContent = exContent.replace(/\.fetchBalance\(user\.exchange_api_key, decryptedSecret, decryptedPassphrase\)/g, '.fetchBalance()');
  
  exContent = exContent.replace(/analyzeMarket\(tickers,/g, 'analyzeMarket(tickers as any,');
  
  fs.writeFileSync(exPath, exContent, 'utf-8');

  const botPath = path.join(__dirname, '..', 'trading-bot.ts');
  let botContent = fs.readFileSync(botPath, 'utf-8');
  
  botContent = botContent.replace(/fallbackTicker\?\.price/g, 'fallbackTicker?.last?.toNumber()');
  botContent = botContent.replace(/new AdapterCandleProvider\(adapter\)/g, 'new AdapterCandleProvider(adapter as any)');
  
  fs.writeFileSync(botPath, botContent, 'utf-8');
  console.log("Types fixed round 3.");
}

fixTypesRound3();
