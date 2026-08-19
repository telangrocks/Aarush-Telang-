import { OrderRequest } from '../../exchanges/models/NormalizedDomain';

export type IntentStatus =
  | 'NONE'
  | 'INTENT_PERSISTED'
  | 'DISPATCHED'
  | 'UNKNOWN'
  | 'RECONCILIATION_PENDING'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'FAILED'
  | 'ORDER_NOT_FOUND_AFTER_EXHAUSTIVE_RECONCILIATION'
  | 'OPERATOR_ATTENTION'
  | 'REJECTED_BY_RISK_GATE';

export type ProtectionStatus =
  | 'UNPROTECTED'
  | 'PROT_PENDING'
  | 'PROT_DISPATCHED'
  | 'PROT_RECON_PENDING'
  | 'PROT_CONFIRMED';

export type EmergencyCloseStatus =
  | 'EMERGENCY_PENDING'
  | 'CLOSE_INTENT_PERSISTED'
  | 'CLOSE_DISPATCHED'
  | 'CLOSE_RECON_PENDING'
  | 'CLOSED'
  | 'REMAINING_POSITION';

export interface EconomicIntent {
  intentId: string; // UUIDv4 representing immutable clientOrderId
  version: number;  // Monotonically increasing for D1 sync
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'limit' | 'market';
  qty: string;
  price?: string;
  status: IntentStatus;
  
  // Natively attached Bybit Linear Protection parameters
  requestedStopLoss?: string;
  requestedTakeProfit?: string;
  
  // Timing / Reconciliation limits
  createdAt: number;
  dispatchedAt?: number;
  lastReconciliationAttempt?: number;
  reconciliationAttemptCount: number;
  
  // DO Wallet payload snapshot
  payloadSnapshot?: OrderRequest;
  
  // Reconciliation fields
  actualExecutedQuantity?: string;
  actualFillPrice?: string;
  actualOrderId?: string;
}

export interface ProtectionIntent {
  intentId: string;
  version: number;
  symbol: string;
  status: ProtectionStatus;
  verifiedStopLoss?: string;
  verifiedTakeProfit?: string;
  verifiedSize?: string;
  createdAt: number;
  lastVerificationAttempt?: number;
}

export interface EmergencyCloseIntent {
  closeIntentId: string; // UUIDv4
  version: number;
  symbol: string;
  status: EmergencyCloseStatus;
  targetSize: string; // The position size it attempted to close
  createdAt: number;
  dispatchedAt?: number;
  reconciliationAttemptCount: number;
}
