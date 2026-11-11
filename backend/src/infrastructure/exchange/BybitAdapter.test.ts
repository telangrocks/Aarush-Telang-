import { describe, it, expect, beforeEach } from 'vitest';
import { BybitAdapter } from './adapters/BybitAdapter';

describe('BybitAdapter V5 Unit Tests', () => {
  let adapter: BybitAdapter;

  beforeEach(() => {
    adapter = new BybitAdapter();
  });

  it('selects correct environment hosts for mainnet, demo, and testnet', async () => {
    await adapter.connect({ environment: 'mainnet' });
    expect(adapter.getHost()).toBe('https://api.bybit.com');

    await adapter.connect({ environment: 'demo' });
    expect(adapter.getHost()).toBe('https://api-demo.bybit.com');

    await adapter.connect({ environment: 'testnet' });
    expect(adapter.getHost()).toBe('https://api-testnet.bybit.com');
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
      if (path === '/v5/order/create') capturedParams = params;
      return { orderId: 'test_order_123', orderLinkId: params.orderLinkId };
    };

    const orderReq = {
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      amount: new (require('bignumber.js'))(0.0015),
      clientOrderId: 'alert_test_123',
      positionIdx: 0,
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
    it('correctly validates Bybit Real UTA account with ContractTrade orders and transfer/convert permissions', async () => {
      await adapter.connect({ environment: 'mainnet', apiKey: 'liveKey', secret: 'liveSec' });
      (adapter as any).makeRequest = async () => ({
        readOnly: 0,
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Spot: ['SpotTrade'],
          Wallet: ['AccountTransfer', 'SubMemberTransfer'],
          Exchange: ['ExchangeHistory'],
        },
      });

      const perms = await adapter.checkApiKeyPermissions();
      expect(perms.isValid).toBe(true);
      expect(perms.readOnly).toBe(false);
      expect(perms.hasTradingPermission).toBe(true);
      expect(perms.hasWithdrawPermission).toBe(false);
      expect(perms.withdrawalVerificationStatus).toBe('DISABLED');
    });

    it('correctly detects Read-Only API key', async () => {
      await adapter.connect({ environment: 'mainnet', apiKey: 'roKey', secret: 'roSec' });
      (adapter as any).makeRequest = async () => ({
        readOnly: 1,
        permissions: { Wallet: ['AccountTransfer'] },
      });

      const perms = await adapter.checkApiKeyPermissions();
      expect(perms.isValid).toBe(true);
      expect(perms.readOnly).toBe(true);
      expect(perms.hasTradingPermission).toBe(false);
    });

    it('correctly validates Bybit Demo simulated trading keys without withdrawal permission', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'demoKey', secret: 'demoSec' });
      (adapter as any).makeRequest = async () => ({
        readOnly: 0,
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Spot: ['SpotTrade'],
          Wallet: ['AccountTransfer', 'SubMemberTransferList'],
        },
      });

      const perms = await adapter.checkApiKeyPermissions();
      expect(perms.isValid).toBe(true);
      expect(perms.readOnly).toBe(false);
      expect(perms.hasTradingPermission).toBe(true);
      expect(perms.hasWithdrawPermission).toBe(false);
      expect(perms.withdrawalVerificationStatus).toBe('DISABLED');
    });

    it('rejects API key with withdrawal permission enabled with WITHDRAWAL_PERMISSION_FORBIDDEN', async () => {
      await adapter.connect({ environment: 'mainnet', apiKey: 'withdrawKey', secret: 'withdrawSec' });
      (adapter as any).makeRequest = async () => ({
        readOnly: 0,
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Wallet: ['AccountTransfer', 'Withdraw'],
        },
      });

      await expect(adapter.checkApiKeyPermissions()).rejects.toMatchObject({
        code: 'WITHDRAWAL_PERMISSION_FORBIDDEN',
        status: 400,
      });
    });

    it('rejects missing, null, or unrecognized permission structures safely with PERMISSION_VERIFICATION_FAILED', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'demoKey', secret: 'demoSec' });

      (adapter as any).makeRequest = async () => ({ readOnly: 0 });
      await expect(adapter.checkApiKeyPermissions()).rejects.toMatchObject({
        code: 'PERMISSION_VERIFICATION_FAILED',
      });

      (adapter as any).makeRequest = async () => ({ readOnly: 0, permissions: null });
      await expect(adapter.checkApiKeyPermissions()).rejects.toMatchObject({
        code: 'PERMISSION_VERIFICATION_FAILED',
      });

      (adapter as any).makeRequest = async () => ({ readOnly: 0, permissions: {} });
      await expect(adapter.checkApiKeyPermissions()).rejects.toMatchObject({
        code: 'PERMISSION_VERIFICATION_FAILED',
      });
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

  describe('TickSize and StepSize Precision Quantization', () => {
    it('quantizes SOLUSDT (tickSize=0.01, stepSize=0.1) BUY order with exact 2-decimal TP/SL and 1-decimal qty', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'testKey', secret: 'testSecret' });

      let capturedParams: any = null;
      (adapter as any).makeRequest = async (_method: string, _path: string, params: any) => {
        if (_path === '/v5/order/create') capturedParams = params;
        return { orderId: 'ord_sol_1', orderLinkId: params.orderLinkId };
      };

      const BigNumber = require('bignumber.js');
      const res = await adapter.createOrder({
        symbol: 'SOL/USDT',
        side: 'buy',
        type: 'market',
        amount: new BigNumber(1.2847),
        clientOrderId: 'sol_alert_1',
        positionIdx: 0,
        takeProfit: 145.6789,
        stopLoss: 132.4531,
        params: {
          tickSize: 0.01,
          stepSize: 0.1
        }
      } as any);

      expect(res.id).toBe('ord_sol_1');
      expect(capturedParams.qty).toBe('1.2'); // floored to stepSize 0.1
      expect(capturedParams.takeProfit).toBe('145.68'); // ceiled to tickSize 0.01 for BUY
      expect(capturedParams.stopLoss).toBe('132.45'); // floored to tickSize 0.01 for BUY
    });

    it('quantizes BTCUSDT (tickSize=0.1, stepSize=0.001) SELL order with exact 1-decimal TP/SL and 3-decimal qty', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'testKey', secret: 'testSecret' });

      let capturedParams: any = null;
      (adapter as any).makeRequest = async (_method: string, _path: string, params: any) => {
        if (_path === '/v5/order/create') capturedParams = params;
        return { orderId: 'ord_btc_1', orderLinkId: params.orderLinkId };
      };

      const BigNumber = require('bignumber.js');
      const res = await adapter.createOrder({
        symbol: 'BTC/USDT',
        side: 'sell',
        type: 'market',
        amount: new BigNumber(0.0058),
        clientOrderId: 'btc_alert_sell',
        positionIdx: 0,
        takeProfit: 63123.456,
        stopLoss: 67890.123,
        params: {
          tickSize: 0.1,
          stepSize: 0.001
        }
      } as any);

      expect(res.id).toBe('ord_btc_1');
      expect(capturedParams.qty).toBe('0.005'); // floored to stepSize 0.001
      expect(capturedParams.takeProfit).toBe('63123.4'); // floored to tickSize 0.1 for SELL
      expect(capturedParams.stopLoss).toBe('67890.2'); // ceiled to tickSize 0.1 for SELL
    });
  });

  describe('Authoritative Bybit Instrument Metadata Mapping', () => {
    it('correctly maps minOrderQty, maxOrderQty, maxMktOrderQty, price limits, and info object', () => {
      const rawItem = {
        symbol: 'BTCUSDT',
        baseCoin: 'BTC',
        quoteCoin: 'USDT',
        status: 'Trading',
        priceFilter: {
          tickSize: '0.10',
          minPrice: '0.50',
          maxPrice: '999999.00'
        },
        lotSizeFilter: {
          minOrderQty: '0.001',
          maxOrderQty: '100.000',
          maxMktOrderQty: '50.000',
          qtyStep: '0.001',
          minNotionalValue: '5'
        }
      };

      const market = (adapter as any).mapInstrumentToMarket(rawItem, 'linear');
      expect(market.symbol).toBe('BTC/USDT');
      expect(market.precision.amount).toBe(0.001);
      expect(market.precision.price).toBe(0.1);
      expect(market.limits.amount.min.toNumber()).toBe(0.001);
      expect(market.limits.amount.max.toNumber()).toBe(100);
      expect((market.limits as any).marketAmount?.max?.toNumber()).toBe(50);
      expect(market.limits.price.min.toNumber()).toBe(0.5);
      expect(market.limits.price.max.toNumber()).toBe(999999);
      expect(market.limits.cost.min.toNumber()).toBe(5);
      expect(market.info).toBe(rawItem);
    });

    it('preserves distinction between genuinely absent, explicit zero, negative, and malformed maximums', () => {
      // 1. Genuinely absent
      const itemAbsent = {
        symbol: 'XRPUSDT',
        baseCoin: 'XRP',
        quoteCoin: 'USDT',
        lotSizeFilter: { minOrderQty: '0.1', qtyStep: '0.1', minNotionalValue: '5' }
      };
      const marketAbsent = (adapter as any).mapInstrumentToMarket(itemAbsent, 'linear');
      expect(marketAbsent.limits.amount.max).toBeUndefined();
      expect((marketAbsent.limits as any).marketAmount?.max).toBeUndefined();

      // 2. Explicit zero
      const itemZero = {
        symbol: 'XRPUSDT',
        baseCoin: 'XRP',
        quoteCoin: 'USDT',
        lotSizeFilter: { minOrderQty: '0.1', qtyStep: '0.1', maxOrderQty: '0', maxMktOrderQty: '0' }
      };
      const marketZero = (adapter as any).mapInstrumentToMarket(itemZero, 'linear');
      expect(marketZero.limits.amount.max.toNumber()).toBe(0);
      expect((marketZero.limits as any).marketAmount?.max?.toNumber()).toBe(0);

      // 3. Negative value
      const itemNeg = {
        symbol: 'XRPUSDT',
        baseCoin: 'XRP',
        quoteCoin: 'USDT',
        lotSizeFilter: { minOrderQty: '0.1', qtyStep: '0.1', maxOrderQty: '-5' }
      };
      const marketNeg = (adapter as any).mapInstrumentToMarket(itemNeg, 'linear');
      expect(marketNeg.limits.amount.max.toNumber()).toBe(-5);

      // 4. Malformed value
      const itemMalformed = {
        symbol: 'XRPUSDT',
        baseCoin: 'XRP',
        quoteCoin: 'USDT',
        lotSizeFilter: { minOrderQty: '0.1', qtyStep: '0.1', maxOrderQty: 'invalid', maxMktOrderQty: 'Infinity' }
      };
      const marketMalformed = (adapter as any).mapInstrumentToMarket(itemMalformed, 'linear');
      expect(marketMalformed.limits.amount.max.isNaN()).toBe(true);
      expect(marketMalformed.limits.marketAmount?.max?.isFinite()).toBe(false);
    });
  });

  describe('F-09 Position Mode Resolution Invariants', () => {
    it('serializes One-Way Mode (positionIdx: 0) into Bybit order payload', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'testKey', secret: 'testSecret' });

      let capturedParams: any = null;
      (adapter as any).makeRequest = async (_method: string, path: string, params: any) => {
        if (path === '/v5/order/create') {
          capturedParams = params;
          return { orderId: 'ord_oneway_1', orderLinkId: params.orderLinkId };
        }
        return {};
      };

      const BigNumber = require('bignumber.js');
      await adapter.createOrder({
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        amount: new BigNumber(0.001),
        positionIdx: 0,
        clientOrderId: 'oneway_order',
      } as any);

      expect(capturedParams.positionIdx).toBe(0);
      expect(capturedParams.orderType).toBe('Market');
      expect(capturedParams.timeInForce).toBeUndefined();
    });

    it('serializes Hedge Mode with positionIdx 1 for BUY and 2 for SELL', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'testKey', secret: 'testSecret' });

      let capturedBuyParams: any = null;
      let capturedSellParams: any = null;
      (adapter as any).makeRequest = async (_method: string, path: string, params: any) => {
        if (path === '/v5/order/create') {
          if (params.side === 'Buy') capturedBuyParams = params;
          else capturedSellParams = params;
          return { orderId: 'ord_hedge', orderLinkId: params.orderLinkId };
        }
        return {};
      };

      const BigNumber = require('bignumber.js');
      // BUY order -> positionIdx 1
      await adapter.createOrder({
        symbol: 'ETH/USDT',
        side: 'buy',
        type: 'market',
        amount: new BigNumber(0.05),
        positionIdx: 1,
        clientOrderId: 'hedge_buy_order',
      } as any);
      expect(capturedBuyParams.positionIdx).toBe(1);

      // SELL order -> positionIdx 2
      await adapter.createOrder({
        symbol: 'ETH/USDT',
        side: 'sell',
        type: 'market',
        amount: new BigNumber(0.05),
        positionIdx: 2,
        clientOrderId: 'hedge_sell_order',
      } as any);
      expect(capturedSellParams.positionIdx).toBe(2);
    });

    it('parses fetchPositions mapping positionIdx, preserving undefined on missing index', async () => {
      await adapter.connect({ environment: 'demo', apiKey: 'testKey', secret: 'testSecret' });

      (adapter as any).makeRequest = async (_method: string, path: string, params: any) => {
        if (path === '/v5/position/list') {
          if (params.symbol === 'BTCUSDT') {
            return { list: [{ symbol: 'BTCUSDT', side: 'Buy', size: '0', positionIdx: 0 }] };
          }
          if (params.symbol === 'ETHUSDT') {
            return {
              list: [
                { symbol: 'ETHUSDT', side: 'Buy', size: '0', positionIdx: 1 },
                { symbol: 'ETHUSDT', side: 'Sell', size: '0', positionIdx: 2 },
              ]
            };
          }
          if (params.symbol === 'SOLUSDT') {
            return { list: [{ symbol: 'SOLUSDT', side: 'Buy', size: '0' }] }; // missing positionIdx
          }
        }
        return {};
      };

      const btcPositions = await adapter.fetchPositions('linear', 'BTC/USDT', true);
      expect(btcPositions).toHaveLength(1);
      expect((btcPositions[0] as any).positionIdx).toBe(0);

      const ethPositions = await adapter.fetchPositions('linear', 'ETH/USDT', true);
      expect(ethPositions).toHaveLength(2);
      expect((ethPositions[0] as any).positionIdx).toBe(1);
      expect((ethPositions[1] as any).positionIdx).toBe(2);

      const solPositions = await adapter.fetchPositions('linear', 'SOL/USDT', true);
      expect(solPositions).toHaveLength(1);
      expect((solPositions[0] as any).positionIdx).toBeUndefined();
    });
  });
});
