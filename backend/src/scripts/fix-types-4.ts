import * as fs from 'fs';
import * as path from 'path';

function fixTypesRound4() {
  const exPath = path.join(__dirname, '..', 'handlers', 'exchange.ts');
  let exContent = fs.readFileSync(exPath, 'utf-8');
  exContent = exContent.replace(/adapter\.config\.environment/g, 'resolvedEnvironment');
  exContent = exContent.replace(/!adapter\.fetchBalances/g, '!adapter.fetchBalance');
  exContent = exContent.replace(/new AdapterCandleProvider\(adapter\)/g, 'new AdapterCandleProvider(adapter as any)');
  fs.writeFileSync(exPath, exContent, 'utf-8');

  const botPath = path.join(__dirname, '..', 'trading-bot.ts');
  let botContent = fs.readFileSync(botPath, 'utf-8');
  botContent = botContent.replace(/new AdapterCandleProvider\(adapter\)/g, 'new AdapterCandleProvider(adapter as any)');
  botContent = botContent.replace(/new AdapterCandleProvider\(writeProvider\)/g, 'new AdapterCandleProvider(writeProvider as any)');
  fs.writeFileSync(botPath, botContent, 'utf-8');

  console.log("Types fixed round 4.");
}

fixTypesRound4();
