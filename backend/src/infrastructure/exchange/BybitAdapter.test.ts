import { describe, it, expect, beforeEach } from 'vitest';
import { BybitAdapter } from './adapters/BybitAdapter';

describe('BybitAdapter V5 Unit Tests', () => {
  let adapter: BybitAdapter;

  beforeEach(() => {
    adapter = new BybitAdapter();
  });

  it('selects correct environment hosts for mainnet and demo', async () => {
    await adapter.connect({ environment: 'mainnet' });
    expect(adapter.getHost()).toBe('https://api.bybit.com');

    await adapter.connect({ environment: 'demo' });
    expect(adapter.getHost()).toBe('https://api-demo.bybit.com');
  });

  it('normalizes symbols consistently', () => {
    expect(adapter.normalizeSymbol('BTC/USDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('BTCUSDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('BTC-USDT').canonicalSymbol).toBe('BTC/USDT');
    expect(adapter.normalizeSymbol('ETH_USDT').canonicalSymbol).toBe('ETH/USDT');
  });

  it('rejects private requests when API credentials are missing', async () => {
    await adapter.connect({ environment: 'demo' });
    await expect(adapter.fetchBalance()).rejects.toThrow('Missing required exchange credentials');
  });

  it('keeps supportsOco as false for linear position protection', () => {
    expect(adapter.capabilities.supportsOco).toBe(false);
  });

  it('builds createOrder payload with category=linear and serializes TP/SL', async () => {
    await adapter.connect({ environment: 'demo', apiKey: 'testKey', secret: 'testSecret' });

    let capturedParams: any = null;
    (adapter as any).makeRequest = async (method: string, path: string, params: any) => {
      capturedParams = params;
      return { orderId: 'test_order_123', orderLinkId: params.orderLinkId };
    };

    const orderReq = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      amount: new (require('bignumber.js'))(0.0015),
      clientOrderId: 'alert_test_123',
      takeProfit: 67000.5,
      stopLoss: 63000.25,
    } as any;

    const res = await adapter.createOrder(orderReq);

    expect(res.id).toBe('test_order_123');
    expect(capturedParams.category).toBe('linear');
    expect(capturedParams.symbol).toBe('BTCUSDT');
    expect(capturedParams.side).toBe('Buy');
    expect(capturedParams.orderType).toBe('Market');
    expect(capturedParams.takeProfit).toBe('67000.5');
    expect(capturedParams.stopLoss).toBe('63000.25');
  });

  describe('Permission Parsing & Validation Fixtures', () => {
    it('correctly validates Bybit Real UTA account with ContractTrade orders', async () => {
      await adapter.connect({ environment: 'mainnet', apiKey: 'liveKey', secret: 'liveSec' });
      (adapter as any).makeRequest = async () => ({
        readOnly: 0,
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Spot: ['SpotTrade'],
          Wallet: ['AccountBalance']
        },
      });

      const perms = await adapter.checkApiKeyPermissions();
      expect(perms.isValid).toBe(true);
      expect(perms.readOnly).toBe(false);
      expect(perms.hasTradingPermission).toBe(true);
    });

    it('correctly detects Read-Only API key', async () => {
      await adapter.connect({ environment: 'mainnet', apiKey: 'roKey', secret: 'roSec' });
      (adapter as any).makeRequest = async () => ({
        readOnly: 1,
        permissions: { Wallet: ['AccountBalance'] },
      });

      const perms = await adapter.checkApiKeyPermissions();
      expect(perms.isValid).toBe(true);
      expect(perms.readOnly).toBe(true);
      expect(perms.hasTradingPermission).toBe(false);
    });

    it('correctly validates Bybit Demo simulated trading keys', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'demoKey', secret: 'demoSec' });
      (adapter as any).makeRequest = async () => ({
        readOnly: 0,
        permissions: {},
      });

      const perms = await adapter.checkApiKeyPermissions();
      expect(perms.isValid).toBe(true);
      expect(perms.readOnly).toBe(false);
      expect(perms.hasTradingPermission).toBe(true);
    });
  });

  describe('Wallet Balance UNIFIED Fast Path', () => {
    it('returns immediately upon successful UNIFIED account balance without calling SPOT/CONTRACT', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'demoKey', secret: 'demoSec' });
      const calledAccountTypes: string[] = [];

      (adapter as any).makeRequest = async (_method: string, _path: string, params: any) => {
        calledAccountTypes.push(params.accountType);
        return {
          list: [
            {
              coin: [
                { coin: 'USDT', walletBalance: '10000', availableToWithdraw: '9500', locked: '500' }
              ]
            }
          ]
        };
      };

      const balances = await adapter.fetchBalance();
      expect(balances.length).toBe(1);
      expect(balances[0].currency).toBe('USDT');
      expect(balances[0].free.toString()).toBe('9500');
      expect(balances[0].total.toString()).toBe('10000');
      expect(calledAccountTypes).toEqual(['UNIFIED']);
    });
  });
});
