import { ICandleProvider } from './CandleProvider';
import { Timeframe } from './Timeframe';
import { NormalizedCandle } from './MarketSnapshot';
import { IExchangeProvider } from '../../exchanges';
import { Ticker } from '../../exchanges/models/NormalizedDomain';
import { Kline } from '../../exchanges/types';

export class AdapterCandleProvider implements ICandleProvider {
  constructor(private adapter: IExchangeProvider) {}

  async fetchCandles(symbol: string, timeframe: Timeframe, limit: number = 100): Promise<NormalizedCandle[]> {
    const klines = await this.adapter.fetchKlines(symbol, timeframe, limit);
    return klines.map((k: Kline) => ({
      timestamp: k.openTime,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume
    }));
  }

  async fetchTicker(symbol: string): Promise<Ticker | null> {
    return this.adapter.fetchTicker(symbol);
  }
}
