import { describe, it, expect } from 'vitest';
import { ConfigService } from './config/ConfigService';
import { StructuredLogger, MetricsCollector } from './telemetry/Telemetry';
import { Container } from './di/Container';

describe('Infrastructure Layer Unit Tests', () => {
  it('ConfigService parses environment configuration with fallbacks', () => {
    const config = new ConfigService({ ENCRYPTION_KEY: 'test_key_32_chars_long_1234567' });
    expect(config.exchangeConfig.timeoutMs).toBe(10000);
    expect(config.cacheConfig.maxCapacity).toBe(50);
    expect(config.getEncryptionKey()).toBe('test_key_32_chars_long_1234567');
  });

  it('StructuredLogger redacts secret parameters from logs', () => {
    const logger = new StructuredLogger();
    expect(() => logger.info('Test log', { apiKey: 'secret_123', safe: 'data' })).not.toThrow();
  });

  it('MetricsCollector accumulates counters and latencies', () => {
    MetricsCollector.increment('test_counter', 1);
    MetricsCollector.recordLatency('test_latency', 100);
    const metrics = MetricsCollector.getMetrics();
    expect(metrics.counters['test_counter']).toBe(1);
    expect(metrics.histograms['test_latency'].count).toBe(1);
    expect(metrics.histograms['test_latency'].avg).toBe(100);
  });

  it('DI Container registers and resolves instances correctly', () => {
    const container = new Container();
    container.register('config', () => new ConfigService());
    expect(container.has('config')).toBe(true);
    const resolved = container.resolve<ConfigService>('config');
    expect(resolved).toBeInstanceOf(ConfigService);
  });
});
