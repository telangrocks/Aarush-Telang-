import * as fs from 'fs';
import * as path from 'path';

function fixExtraParens(filePath: string) {
  let content = fs.readFileSync(filePath, 'utf-8');
  content = content.replace(/\)\)\);/g, '));');
  content = content.replace(/\)\)\)/g, '))'); // general cleanup just in case, but be careful
  
  // Actually, specifically we have things like:
  // const adapter = (await ExchangeManager.getProvider(user.exchange_name as ExchangeName, { environment: normalizeEnvironment(user.exchange_environment) })));
  content = content.replace(/\}\)\)\);/g, '})));');
  // Wait, let's just do a string replace of the exact lines that fail:
  // "normalizeEnvironment(user.exchange_environment) })));"
  content = content.replace(/environment: normalizeEnvironment\(([^)]+)\) \}\)\)\);/g, 'environment: normalizeEnvironment($1) }));');
  content = content.replace(/environment: normalizeEnvironment\(([^)]+)\) \}\)\)/g, 'environment: normalizeEnvironment($1) })');
  
  // also fix double parens where we have `const adapter = (await ExchangeManager.getProvider...));`
  content = content.replace(/const adapter = \(await ExchangeManager\.getProvider\(([^,]+),\s*\{\s*environment:\s*normalizeEnvironment\(([^)]+)\)\s*\}\)\)\);/g, 'const adapter = await ExchangeManager.getProvider($1, { environment: normalizeEnvironment($2) });');
  content = content.replace(/const adapter = \(await ExchangeManager\.getProvider\(([^,]+),\s*\{\s*environment:\s*normalizeEnvironment\(([^)]+)\)\s*\}\)\);/g, 'const adapter = await ExchangeManager.getProvider($1, { environment: normalizeEnvironment($2) });');
  
  fs.writeFileSync(filePath, content, 'utf-8');
}

fixExtraParens(path.join(__dirname, '..', 'handlers', 'exchange.ts'));
fixExtraParens(path.join(__dirname, '..', 'trading-bot.ts'));
console.log("Parens fixed.");
