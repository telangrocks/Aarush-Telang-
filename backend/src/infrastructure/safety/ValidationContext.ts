import { ExchangeCapabilities } from '../../domain/capabilities/ExchangeCapabilities';
import { RuntimeState } from '../runtime/RuntimeState';
import { JournalRecord } from '../runtime/ExecutionJournal';

export interface MarketRulesSummary {
  readonly symbol: string;
  readonly minNotional?: number;
  readonly maxNotional?: number;
  readonly minQty?: number;
  readonly maxQty?: number;
  readonly stepSize?: number;
  readonly tickSize?: number;
  readonly pricePrecision?: number;
  readonly quantityPrecision?: number;
}

export interface OrderValidationIntent {
  readonly clientOrderId?: string;
  readonly intentHash?: string;
  readonly userId: string;
  readonly exchangeId: string;
  readonly environment: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'limit' | 'market' | 'stop_limit';
  readonly price?: number;
  readonly stopPrice?: number;
  readonly quantity?: number;
  readonly notionalUsdt?: number;
  readonly timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'POST_ONLY';
  readonly postOnly?: boolean;
  readonly reduceOnly?: boolean;
  readonly leverage?: number;
}

export interface RiskPolicyLimits {
  readonly maxOrderNotionalUsdt?: number;
  readonly maxDailyLossUsdt?: number;
  readonly currentDailyLossUsdt?: number;
  readonly maxLeverage?: number;
  readonly maxOpenPositionsCount?: number;
  readonly isKillSwitchActive?: boolean;
  readonly cooldownMs?: number;
  readonly lastTradeTimestamp?: number;
}

export interface ValidationContextParams {
  readonly intent: OrderValidationIntent;
  readonly marketRules?: MarketRulesSummary;
  readonly accountBalanceUsdt?: number;
  readonly openPositions?: Array<{ symbol: string; size: number; side: 'long' | 'short' }>;
  readonly capabilities?: ExchangeCapabilities;
  readonly runtimeState?: RuntimeState;
  readonly journalCheckpoints?: JournalRecord[];
  readonly riskLimits?: RiskPolicyLimits;
}

export class ValidationContext {
  readonly intent: OrderValidationIntent;
  readonly marketRules?: MarketRulesSummary;
  readonly accountBalanceUsdt?: number;
  readonly openPositions: ReadonlyArray<{ symbol: string; size: number; side: 'long' | 'short' }>;
  readonly capabilities?: ExchangeCapabilities;
  readonly runtimeState?: RuntimeState;
  readonly journalCheckpoints: ReadonlyArray<JournalRecord>;
  readonly riskLimits?: RiskPolicyLimits;

  constructor(params: ValidationContextParams) {
    this.intent = Object.freeze({ ...params.intent });
    this.marketRules = params.marketRules ? Object.freeze({ ...params.marketRules }) : undefined;
    this.accountBalanceUsdt = params.accountBalanceUsdt;
    this.openPositions = Object.freeze(params.openPositions ? [...params.openPositions] : []);
    this.capabilities = params.capabilities;
    this.runtimeState = params.runtimeState;
    this.journalCheckpoints = Object.freeze(params.journalCheckpoints ? [...params.journalCheckpoints] : []);
    this.riskLimits = params.riskLimits ? Object.freeze({ ...params.riskLimits }) : undefined;
    Object.freeze(this);
  }
}
