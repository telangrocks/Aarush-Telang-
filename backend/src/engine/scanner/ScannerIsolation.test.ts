import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Scanner Safety & Execution Isolation Invariant', () => {
  const scannerDir = path.resolve(__dirname);

  it('proves that scanner modules have ZERO imports of EconomicIntent or WAL execution types', () => {
    const files = fs.readdirSync(scannerDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);

    const forbiddenTerms = [
      'EconomicIntent',
      'ProtectionIntent',
      'createOrder',
      'executeOrder',
      'dispatchOrder',
      'trade_positions',
      'pendingPositionSync',
      'WalTypes',
      'TradeValidator',
    ];

    for (const file of files) {
      const filePath = path.join(scannerDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');

      for (const term of forbiddenTerms) {
        const importPattern = new RegExp(`import.*${term}.*from`, 'i');
        const match = content.match(importPattern);
        expect(match, `Forbidden execution import '${term}' found in scanner file: ${file}`).toBeNull();
      }
    }
  });

  it('verifies that scanner modules do not instantiate or export order dispatch mechanisms', async () => {
    const scannerModule = await import('./index');

    const exportedKeys = Object.keys(scannerModule);
    expect(exportedKeys).toContain('TradingCostEngine');
    expect(exportedKeys).toContain('OpportunityRanker');
    expect(exportedKeys).toContain('MultiTimeframeCandleStore');
    expect(exportedKeys).toContain('StrategyCompatibilityEvaluator');

    const forbiddenMethodPrefixes = ['buy', 'sell', 'order', 'trade', 'dispatch', 'execute'];
    for (const key of exportedKeys) {
      const exportedItem = (scannerModule as any)[key];
      if (typeof exportedItem === 'function' && exportedItem.prototype) {
        const methods = Object.getOwnPropertyNames(exportedItem.prototype);
        for (const method of methods) {
          for (const prefix of forbiddenMethodPrefixes) {
            const isForbidden = method.toLowerCase().startsWith(prefix) &&
              !method.toLowerCase().includes('cost') &&
              !method.toLowerCase().includes('candle') &&
              !method.toLowerCase().includes('score');
            expect(isForbidden, `Suspicious execution-like method '${method}' on ${key}`).toBe(false);
          }
        }
      }
    }
  });
});
