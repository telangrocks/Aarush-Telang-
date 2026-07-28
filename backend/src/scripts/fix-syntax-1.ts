import * as fs from 'fs';
import * as path from 'path';

function fixSyntax(filePath: string) {
  let content = fs.readFileSync(filePath, 'utf-8');
  content = content.replace(/const adapter = \(await ExchangeManager\.getProvider/g, 'const adapter = await ExchangeManager.getProvider');
  content = content.replace(/const ticker = user\?\.exchange_name \? await \(await ExchangeManager\.getProvider/g, 'const ticker = user?.exchange_name ? await (await ExchangeManager.getProvider');
  fs.writeFileSync(filePath, content, 'utf-8');
}

fixSyntax(path.join(__dirname, '..', 'handlers', 'exchange.ts'));
fixSyntax(path.join(__dirname, '..', 'trading-bot.ts'));

console.log("Syntax fixed part 1.");
