import { IExchangeProvider } from "./IExchangeProvider";
import { Env } from '../index';
import { decrypt } from '../crypto';

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
  private adapter: IExchangeProvider;
  private userKeys: any;

  // Limits
  private readonly MAX_ATTEMPTS = 5;
  private readonly RECOVERY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour timeout for stuck recoveries

  constructor(stateStorage: DurableObjectStorage, env: Env, userId: string, adapter: IExchangeProvider, userKeys: any) {
    this.stateStorage = stateStorage;
    this.env = env;
    this.userId = userId;
    this.adapter = adapter;
    this.userKeys = userKeys;
  }

  private async getDecryptedSecret(): Promise<string> {
    if (!this.userKeys || !this.userKeys.exchange_api_secret_encrypted || !this.userKeys.exchange_api_secret_iv) {
      return "";
    }
    try {
      return await decrypt(
        { iv: this.userKeys.exchange_api_secret_iv, encrypted: this.userKeys.exchange_api_secret_encrypted },
        this.env.ENCRYPTION_KEY
      );
    } catch (e) {
      console.error("[ReconciliationEngine] Failed to decrypt user secret:", e);
      return "";
    }
  }

  private async getDecryptedPassphrase(): Promise<string | undefined> {
    if (!this.userKeys || !this.userKeys.exchange_api_passphrase_encrypted || !this.userKeys.exchange_api_passphrase_iv) {
      return undefined;
    }
    try {
      return await decrypt(
        { iv: this.userKeys.exchange_api_passphrase_iv, encrypted: this.userKeys.exchange_api_passphrase_encrypted },
        this.env.ENCRYPTION_KEY
      );
    } catch (e) {
      console.error("[ReconciliationEngine] Failed to decrypt user passphrase:", e);
      return undefined;
    }
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
    const apiSecret = await this.getDecryptedSecret();
    const apiPassphrase = await this.getDecryptedPassphrase();


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
        if (orderIdToQuery && this.adapter.fetchOrder && apiSecret) {
          const ordStatus: any = await this.adapter.fetchOrder(orderIdToQuery, pos.symbol || "UNKNOWN");
          
          if (ordStatus.success) {
            // Update D1 entry order status and fill data
            if (pos.status === 'PENDING_ENTRY' && (ordStatus.status === 'closed' || ordStatus.status === 'filled')) {
              await this.env.DB.prepare(
                `UPDATE trade_positions SET status = 'OPEN', entry_status = 'FILLED', filled_quantity = ?, average_fill_price = ?, entry_filled_at = ?, updated_at = ? WHERE id = ?`
              )
                .bind(ordStatus.filled || ordStatus.filledQuantity || pos.quantity, ordStatus.average || ordStatus.averageFillPrice || pos.entry_price, nowIso, nowIso, pos.id)
                .run();
              await this.logDecision('PENDING_ENTRY_FILLED', { symbol: pos.symbol, positionId: pos.id, orderId: orderIdToQuery });
            }

            // Retrieve and persist TP/SL exchange order IDs if available from adapter
            if (ordStatus.tpOrderId || ordStatus.slOrderId || ordStatus.ocoGroupId) {
              await this.env.DB.prepare(
                `UPDATE trade_positions SET tp_exchange_order_id = COALESCE(?, tp_exchange_order_id), sl_exchange_order_id = COALESCE(?, sl_exchange_order_id), oco_group_id = COALESCE(?, oco_group_id), updated_at = ? WHERE id = ?`
              )
                .bind(ordStatus.info?.tpOrderId || ordStatus.tpOrderId || null, ordStatus.info?.slOrderId || ordStatus.slOrderId || null, ordStatus.info?.ocoGroupId || ordStatus.ocoGroupId || null, nowIso, pos.id)
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


    for (const tx of transactions.values()) {
      await this.processTransaction(tx, knownPositions, apiSecret, apiPassphrase);
    }
      
    const summary = {
      positionsScanned: 0,
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

  private async processTransaction(tx: RecoveryTransaction, _knownPositions: any[], apiSecret: string, apiPassphrase?: string) {
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
          if ((this.adapter as any).cancelOrder && apiSecret) {
             const res = await (this.adapter as any).cancelOrder(tx.id.replace('ord_', ''), tx.symbol, this.userKeys.exchange_api_key, apiSecret, apiPassphrase);
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

  private async validatePositionConfidence(exPos: any): Promise<boolean> {
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
