import * as fs from 'fs';
import * as path from 'path';

function ultimateFix() {
  const rPath = path.join(__dirname, '..', 'exchanges', 'ReconciliationEngine.ts');
  let rContent = fs.readFileSync(rPath, 'utf-8');
  rContent = rContent.replace(/import \{.*?\} from '\.\/BaseExchange';/g, '');
  fs.writeFileSync(rPath, rContent, 'utf-8');

  const mPath = path.join(__dirname, '..', 'market-analysis.ts');
  let mContent = fs.readFileSync(mPath, 'utf-8');
  mContent = mContent.replace(/import \{ MarketTicker, IExchangeAdapter \} from '\.\/exchanges';/g, "import { IExchangeProvider } from './exchanges';");
  mContent = mContent.replace(/export async function analyzeMarket\(tickers: MarketTicker\[\], exchange: IExchangeAdapter\)/g, "export async function analyzeMarket(tickers: any[], exchange: IExchangeProvider)");
  mContent = mContent.replace(/const closes = klines\.map\(\(k\) => k\.close\);/g, 'const closes = klines.map((k: any) => k.close);');
  mContent = mContent.replace(/const volumes = klines\.map\(\(k\) => k\.volume\);/g, 'const volumes = klines.map((k: any) => k.volume);');
  fs.writeFileSync(mPath, mContent, 'utf-8');
}
ultimateFix();
