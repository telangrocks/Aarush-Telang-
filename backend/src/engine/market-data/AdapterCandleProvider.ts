import { ICandleProvider } from './CandleProvider';
import { Timeframe } from './Timeframe';
import { NormalizedCandle } from './MarketSnapshot';
import { IExchangeProvider } from '../../exchanges';
import { Ticker } from '../../exchanges/models/NormalizedDomain';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';

export class AdapterCandleProvider implements ICandleProvider {
  constructor(private adapter: IExchangeProvider) {}

  async fetchCandles(symbol: string, timeframe: Timeframe, limit: number = 100): Promise<NormalizedCandle[]> {
    const klines = await this.adapter.fetchKlines(symbol, timeframe, limit);
    return CandleValidator.sanitizeAndSortCandles(klines);
  }

  async fetchTicker(symbol: string): Promise<Ticker | null> {
    return this.adapter.fetchTicker(symbol);
  }
}
