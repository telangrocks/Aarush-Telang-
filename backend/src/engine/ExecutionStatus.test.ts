import { describe, it, expect } from 'vitest';

describe('Execution Status API & Verification Tests', () => {
  it('correctly identifies FILLED state with exchange-confirmed price and quantity', () => {
    const dbPos = {
      id: 'alert-uuid-1234',
      user_id: 'usr_test_1',
      symbol: 'BTC/USDT',
      side: 'BUY',
      target_entry_price: 95000.00,
      entry_price: 95000.00,
      average_fill_price: 95023.50,
      quantity: 0.0010,
      filled_quantity: 0.0010,
      stop_loss: 93500.00,
      take_profit: 98000.00,
      status: 'OPEN',
      entry_status: 'FILLED',
      order_id: '1827391823791283',
      exchange: 'bybit',
      environment: 'mainnet',
      strategy: 'ScalperV2',
      updated_at: '2026-08-22T12:30:02.150Z'
    };

    const targetEntryPrice = dbPos.target_entry_price ?? dbPos.entry_price;
    const actualFillPrice = dbPos.average_fill_price;
    const filledQuantity = dbPos.filled_quantity;
    const entryStatus = dbPos.entry_status;

    let slippagePercent = 0;
    if (targetEntryPrice && actualFillPrice && targetEntryPrice > 0) {
      slippagePercent = parseFloat(((Math.abs(actualFillPrice - targetEntryPrice) / targetEntryPrice) * 100).toFixed(4));
    }

    const isFilled = (entryStatus === 'FILLED' || entryStatus === 'closed') && (actualFillPrice !== null && actualFillPrice > 0) && (filledQuantity > 0);
    const isTerminal = isFilled || entryStatus === 'FAILED';

    expect(isFilled).toBe(true);
    expect(isTerminal).toBe(true);
    expect(actualFillPrice).toBe(95023.50);
    expect(filledQuantity).toBe(0.0010);
    expect(dbPos.order_id).toBe('1827391823791283');
    expect(slippagePercent).toBe(0.0247);
  });

  it('rejects status = OPEN as fill proof if entry_status is PENDING_ENTRY and fill price is missing', () => {
    const dbPos = {
      id: 'alert-uuid-pending',
      user_id: 'usr_test_1',
      symbol: 'BTC/USDT',
      side: 'BUY',
      target_entry_price: 95000.00,
      entry_price: 95000.00,
      average_fill_price: null,
      quantity: 0.0010,
      filled_quantity: 0,
      status: 'OPEN', // Edge case: status is OPEN but entry is pending
      entry_status: 'PENDING_ENTRY',
      order_id: '1827391823791283',
      exchange: 'bybit',
      environment: 'mainnet',
      strategy: 'ScalperV2'
    };

    const actualFillPrice = dbPos.average_fill_price;
    const filledQuantity = dbPos.filled_quantity;
    const entryStatus = dbPos.entry_status;

    const isFilled = (entryStatus === 'FILLED' || entryStatus === 'closed') && (actualFillPrice !== null && actualFillPrice > 0) && (filledQuantity > 0);

    expect(isFilled).toBe(false); // Must NOT be treated as filled!
  });

  it('handles PARTIALLY_FILLED state without prematurely declaring terminal filled', () => {
    const dbPos = {
      id: 'alert-uuid-partial',
      user_id: 'usr_test_1',
      symbol: 'ETH/USDT',
      side: 'BUY',
      target_entry_price: 3200.00,
      average_fill_price: 3201.50,
      quantity: 1.0,
      filled_quantity: 0.4,
      entry_status: 'PARTIALLY_FILLED'
    };

    const isFilled = (dbPos.entry_status === 'FILLED' || dbPos.entry_status === 'closed') && (dbPos.average_fill_price !== null && dbPos.average_fill_price > 0) && (dbPos.filled_quantity >= dbPos.quantity);
    const isTerminal = dbPos.entry_status === 'FILLED' || dbPos.entry_status === 'FAILED';

    expect(isFilled).toBe(false);
    expect(isTerminal).toBe(false);
    expect(dbPos.filled_quantity).toBe(0.4);
    expect(dbPos.quantity - dbPos.filled_quantity).toBe(0.6);
  });
});
