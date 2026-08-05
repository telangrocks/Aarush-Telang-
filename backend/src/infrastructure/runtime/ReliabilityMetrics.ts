import { MetricsCollector, StructuredLogger } from '../telemetry/Telemetry';

export class ReliabilityMetrics {
  private static logger = new StructuredLogger();

  public static recordReconnect(exchangeId: string): void {
    MetricsCollector.increment(`reliability_reconnect_${exchangeId}`, 1);
    this.logger.info(`[ReliabilityMetrics] Reconnect recorded for ${exchangeId}`);
  }

  public static recordWebSocketDowntime(exchangeId: string, durationMs: number): void {
    MetricsCollector.recordLatency(`reliability_ws_downtime_${exchangeId}`, durationMs);
  }

  public static recordReconciliation(exchangeId: string, recoveredOrders: number): void {
    MetricsCollector.increment(`reliability_reconciliation_${exchangeId}`, 1);
    MetricsCollector.increment(`reliability_recovered_orders_${exchangeId}`, recoveredOrders);
    this.logger.info(`[ReliabilityMetrics] Reconciliation completed for ${exchangeId}`, { recoveredOrders });
  }

  public static recordTimeout(operationName: string): void {
    MetricsCollector.increment(`reliability_timeout_${operationName}`, 1);
  }

  public static recordPartialFailure(componentName: string): void {
    MetricsCollector.increment(`reliability_partial_failure_${componentName}`, 1);
  }

  public static recordBotRestart(botId: string): void {
    MetricsCollector.increment(`reliability_bot_restart_${botId}`, 1);
    this.logger.warn(`[ReliabilityMetrics] Bot session restarted`, { botId });
  }
}
