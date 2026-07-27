const { ScalperV2Strategy } = require('../dist/engine/strategies/scalper-v2/ScalperV2Strategy');
const { StrategyContext } = require('../dist/engine/context/StrategyContext');
const { EngineAPIService } = require('../dist/api/engine/EngineAPIService');
const { EngineState } = require('../dist/engine/dto/EngineState');

const strategy = new ScalperV2Strategy();

const context = new StrategyContext({
  symbol: 'BTCUSDT',
  timestamp: Date.now(),
  candles: {
    '5m': [
      { timestamp: Date.now() - 300000, open: 50000, high: 50100, low: 49900, close: 50050, volume: 100 },
      { timestamp: Date.now(), open: 50050, high: 50200, low: 50000, close: 50150, volume: 150 }
    ]
  }
});

const result = strategy.evaluate(context);
const apiService = new EngineAPIService();
const finalOutput = apiService.transform(EngineState.WAITING, 'BTCUSDT', result);

console.log(JSON.stringify(finalOutput, null, 2));
