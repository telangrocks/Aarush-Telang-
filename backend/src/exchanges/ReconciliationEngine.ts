import { Env } from '../index';
import { IExchangeAdapter, PositionResult, OrderResult } from './BaseExchange';

export interface RecoveryTransaction {
  id: string; // usually clientOrderId or position id
  type: 'POSITION' | 'ORDER';
  symbol: string;
  status: 'RECOVERY_PENDING' | 'RECOVERY_VALIDATING' | 'RECOVERY_RECONCILING' | 'RECOVERY_COMPLETED' | 'RECOVERY_FAILED';
  attempts: number;
  lastAttemptAt: number;
  firstDetectedAt: number;
  data: any; // Raw exchange position/order data
}

export class ReconciliationEngine {
  private stateStorage: DurableObjectStorage;
  private env: Env;
  private userId: string;
  private adapter: IExchangeAdapter;
  private userKeys: any;

  // Limits
  private readonly MAX_ATTEMPTS = 5;
  private readonly RECOVERY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour timeout for stuck recoveries

  constructor(stateStorage: DurableObjectStorage, env: Env, userId: string, adapter: IExchangeAdapter, userKeys: any) {
    this.stateStorage = stateStorage;
    this.env = env;
    this.userId = userId;
    this.adapter = adapter;
    this.userKeys = userKeys;
  }

  private async logDecision(action: string, metadata: any) {
    try {
      const id = crypto.randomUUID();
      await this.env.DB.prepare(
        'INSERT INTO audit_log (id, user_id, action, ip, user_agent, metadata) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(id, this.userId, action, 'internal-reconciliation', 'reconciliation-engine', JSON.stringify(metadata))
        .run();
    } catch (e) {
      console.error('Failed to log reconciliation decision:', e);
    }
  }

  private async getTransactions(): Promise<Map<string, RecoveryTransaction>> {
    const txs = await this.stateStorage.get<Map<string, RecoveryTransaction>>('recoveryTransactions');
    return txs ? new Map(txs) : new Map();
  }

  private async saveTransactions(txs: Map<string, RecoveryTransaction>) {
    await this.stateStorage.put('recoveryTransactions', txs);
  }

  private async triggerSafeMode(reason: string) {
    console.error(`Triggering SAFE MODE: ${reason}`);
    await this.stateStorage.put('safeMode', true);
    await this.logDecision('SAFE_MODE_ACTIVATED', { reason });
  }

  public async runReconciliationSweep() {
    const sweepStartTime = Date.now();
    const nowIso = new Date().toISOString();

    // 1. Fetch current exchange state
    let exchangePositions: PositionResult[] = [];
    if (this.adapter.fetchPositions) {
      const posRes = await this.adapter.fetchPositions(this.userKeys.exchange_api_key, this.userKeys.exchange_api_secret_encrypted);
      if (posRes.success) {
        exchangePositions = posRes.result;
      } else {
        console.error("Reconciliation failed to fetch positions:", posRes.message);
        return;
      }
    }

    // 2. Fetch known PENDING_ENTRY and OPEN positions from D1
    const { results } = await this.env.DB.prepare(
      "SELECT * FROM trade_positions WHERE user_id = ? AND status IN ('PENDING_ENTRY', 'OPEN', 'PROTECTION_WARNING')"
    )
      .bind(this.userId)
      .all();
    const knownPositions = (results || []) as any[];

    // 3. Reconcile known D1 positions against exchange order status & protection health
    for (const pos of knownPositions) {
      try {
        const orderIdToQuery = pos.entry_exchange_order_id || pos.order_id;
        if (orderIdToQuery && this.adapter.fetchOrder) {
          const ordStatus = await this.adapter.fetchOrder(orderIdToQuery, this.userKeys.exchange_api_key, this.userKeys.exchange_api_secret_encrypted);
          
          if (ordStatus.success) {
            // Update D1 entry order status and fill data
            if (pos.status === 'PENDING_ENTRY' && ordStatus.status === 'filled') {
              await this.env.DB.prepare(
                `UPDATE trade_positions SET status = 'OPEN', entry_status = 'FILLED', filled_quantity = ?, average_fill_price = ?, entry_filled_at = ?, updated_at = ? WHERE id = ?`
              )
                .bind(ordStatus.filledQuantity || pos.quantity, ordStatus.averageFillPrice || pos.entry_price, nowIso, nowIso, pos.id)
                .run();
              await this.logDecision('PENDING_ENTRY_FILLED', { symbol: pos.symbol, positionId: pos.id, orderId: orderIdToQuery });
            }

            // Retrieve and persist TP/SL exchange order IDs if available from adapter
            if (ordStatus.tpOrderId || ordStatus.slOrderId || ordStatus.ocoGroupId) {
              await this.env.DB.prepare(
                `UPDATE trade_positions SET tp_exchange_order_id = COALESCE(?, tp_exchange_order_id), sl_exchange_order_id = COALESCE(?, sl_exchange_order_id), oco_group_id = COALESCE(?, oco_group_id), updated_at = ? WHERE id = ?`
              )
                .bind(ordStatus.tpOrderId || null, ordStatus.slOrderId || null, ordStatus.ocoGroupId || null, nowIso, pos.id)
                .run();
            }
          }
        }

        // Protection Health Check for ACTIVE / OPEN positions
        if (pos.status === 'OPEN' || pos.status === 'PROTECTION_WARNING') {
          const hasProtectionIds = pos.tp_exchange_order_id || pos.sl_exchange_order_id || pos.oco_group_id || pos.protection_mode === 'ATTACHED_TPSL';
          if (!hasProtectionIds && pos.protection_mode !== 'SOFTWARE_FALLBACK') {
            await this.env.DB.prepare(
              `UPDATE trade_positions SET status = 'PROTECTION_WARNING', last_health_check_at = ?, updated_at = ? WHERE id = ?`
            )
              .bind(nowIso, nowIso, pos.id)
              .run();
            await this.logDecision('PROTECTION_HEALTH_WARNING', { symbol: pos.symbol, positionId: pos.id, reason: 'Missing exchange protection IDs' });
          } else {
            await this.env.DB.prepare(
              `UPDATE trade_positions SET last_health_check_at = ?, updated_at = ? WHERE id = ?`
            )
              .bind(nowIso, nowIso, pos.id)
              .run();
          }
        }
      } catch (err: any) {
        console.error(`Error reconciling position ${pos.id}:`, err);
      }
    }

    const transactions = await this.getTransactions();

    // 4. Identify Orphaned Positions
    for (const exPos of exchangePositions) {
      if (exPos.size > 0) {
        const isKnown = knownPositions.find(p => exPos.symbol.includes(p.symbol) && (
            (exPos.side as any === 'long' && p.side === 'BUY') || 
            (exPos.side as any === 'short' && p.side === 'SELL') ||
            (exPos.side as any === 'both')
        ));

        if (!isKnown) {
          const txId = `pos_${exPos.symbol}`;
          if (!transactions.has(txId)) {
            transactions.set(txId, {
              id: txId,
              type: 'POSITION',
              symbol: exPos.symbol,
              status: 'RECOVERY_PENDING',
              attempts: 0,
              lastAttemptAt: 0,
              firstDetectedAt: Date.now(),
              data: exPos
            });
            await this.logDecision('ORPHANED_POSITION_DETECTED', { symbol: exPos.symbol, size: exPos.size, entry_price: exPos.entry_price });
          }
        }
      }
    }

    // 5. Process all pending recovery transactions
    for (const [txId, tx] of transactions.entries()) {
      await this.processTransaction(tx, knownPositions);
    }
      
    const summary = {
      positionsScanned: exchangePositions.length,
      knownPositionsReconciled: knownPositions.length,
      orphanedPositionsFound: transactions.size,
      executionTimeMs: Date.now() - sweepStartTime,
      status: 'COMPLETED'
    };
    
    await this.stateStorage.put('lastReconciliationSummary', summary);
    await this.logDecision('RECONCILIATION_SWEEP_COMPLETED', summary);

    for (const [txId, tx] of transactions.entries()) {
      if (tx.status === 'RECOVERY_COMPLETED' || tx.status === 'RECOVERY_FAILED') {
         transactions.delete(txId);
      }
    }

    await this.saveTransactions(transactions);
    await this.stateStorage.put('lastReconciliationAt', Date.now());
  }

  private async processTransaction(tx: RecoveryTransaction, knownPositions: any[]) {
    tx.attempts++;
    tx.lastAttemptAt = Date.now();
    const duration = Date.now() - tx.firstDetectedAt;

    if (duration > this.RECOVERY_TIMEOUT_MS || tx.attempts > this.MAX_ATTEMPTS) {
      tx.status = 'RECOVERY_FAILED';
      await this.logDecision('RECOVERY_TIMEOUT', { txId: tx.id, attempts: tx.attempts, duration });
      await this.triggerSafeMode(`Recovery timeout for ${tx.id}`);
      return;
    }

    if (tx.status === 'RECOVERY_PENDING') {
      tx.status = 'RECOVERY_VALIDATING';
      return;
    } else if (tx.status === 'RECOVERY_VALIDATING') {
      if (tx.type === 'POSITION') {
        const isValid = await this.validatePositionConfidence(tx.data);
        if (isValid) {
          tx.status = 'RECOVERY_RECONCILING';
          return;
        } else {
          tx.status = 'RECOVERY_FAILED';
          await this.logDecision('RECOVERY_VALIDATION_FAILED', { txId: tx.id, symbol: tx.symbol });
          await this.triggerSafeMode(`Validation failed for orphaned position ${tx.symbol}`);
          return;
        }
      } else if (tx.type === 'ORDER') {
        tx.status = 'RECOVERY_RECONCILING';
        return;
      }
    } else if (tx.status === 'RECOVERY_RECONCILING') {
      if (tx.type === 'POSITION') {
        try {
          const positionId = crypto.randomUUID();
          const now = new Date().toISOString();
          
          const fillPrice = tx.data.entryPrice || 0;
          await this.env.DB.prepare(
            `INSERT INTO trade_positions (
              id, user_id, symbol, side, entry_price, target_entry_price, average_fill_price, quantity, stop_loss, take_profit,
              status, exchange, environment, strategy, order_id, entry_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            positionId,
            this.userId,
            tx.symbol,
            tx.data.side === 'short' ? 'SELL' : 'BUY',
            fillPrice,
            null,
            fillPrice,
            tx.data.size,
            0, // Requires manual review of SL/TP or advanced parsing
            0,
            this.userKeys.exchange_name,
            this.userKeys.exchange_environment || 'mainnet',
            'recovery',
            null,
            now, now, now
          ).run();

          tx.status = 'RECOVERY_COMPLETED';
          await this.logDecision('RECOVERY_COMPLETED', { txId: tx.id, symbol: tx.symbol, duration, action: 'ADOPTED' });
        } catch (e) {
          console.error(`Failed to reconcile position ${tx.id}:`, e);
          // Will retry next cycle
        }
      } else if (tx.type === 'ORDER') {
        try {
          if ((this.adapter as any).cancelOrder) {
             const res = await (this.adapter as any).cancelOrder(tx.symbol, tx.id.replace('ord_', ''), this.userKeys.exchange_api_key, this.userKeys.exchange_api_secret_encrypted);
             if (res.success) {
               tx.status = 'RECOVERY_COMPLETED';
               await this.logDecision('RECOVERY_COMPLETED', { txId: tx.id, symbol: tx.symbol, action: 'CANCELLED' });
             } else {
               throw new Error(res.message);
             }
          }
        } catch (e) {
           console.error(`Failed to cancel orphaned order ${tx.id}:`, e);
        }
      }
    }
  }

  private async validatePositionConfidence(exPos: PositionResult): Promise<boolean> {
    // strict validation rules
    if (!exPos || exPos.size <= 0) return false;
    const fillPx = exPos.entry_price || 0;
    if (fillPx <= 0) return false;
    // In a real production system, we would validate max leverage, max loss, etc.
    // Here we ensure it has a valid symbol and size, and leverage is not insane.
    if ((exPos as any).leverage && (exPos as any).leverage > 20) return false; 
    
    return true;
  }
}
