/**
 * Production Validation Framework — Execution Context & Empirical Collector
 */

import { ValidationSlaConfig, DEFAULT_VALIDATION_CONFIG } from "../config/ValidationConfig";
import { ValidationLevel } from "./ValidationPhase";
import { SecurityRedactor } from "../utils/SecurityRedactor";
import {
  resolveExchangeForContext,
  ExchangeEnvironment,
  ResolvedExchangeContext,
} from "../config/ExchangeRegistry";

export interface EmpiricalEvidence {
  timestamp: string;
  phaseId: number;
  label: string;
  url?: string;
  httpStatus?: number;
  latencyMs?: number;
  payload?: any;
}

export interface SystemMetadata {
  gitSha: string;
  branch: string;
  workflowRunId: string;
  buildTimestamp: string;
  appVersion: string;
  validatorVersion: string;
}

export class ValidationContext {
  public readonly level: ValidationLevel;
  public readonly workerUrl: string;
  public readonly config: ValidationSlaConfig;
  public readonly metadata: SystemMetadata;
  public readonly empiricalLogs: EmpiricalEvidence[] = [];

  // ── Exchange resolution (set by ExchangeRegistry, never hardcoded) ─────────
  public readonly validationExchangeId: string;
  public readonly validationExchangeEnv: ExchangeEnvironment;
  public readonly resolvedExchange: ResolvedExchangeContext;

  // ── Credentials (populated for authenticated levels only) ──────────────────
  public exchangeApiKey: string = "";
  public exchangeApiSecret: string = "";
  public exchangePassphrase: string = "";

  // ── Runtime state ──────────────────────────────────────────────────────────
  public userEmail: string = "";
  public authToken: string | null = null;
  public selectedCandidateSymbol: string = "BTC/USDT";
  public liveTickerPrice: number = 0;
  public liveCandles: any[] = [];
  public clockDriftMs: number = 0;

  constructor(level: ValidationLevel, workerUrl?: string, customConfig?: Partial<ValidationSlaConfig>) {
    this.level = level;
    this.workerUrl = (workerUrl || process.env.WORKER_URL || "https://crypto-pulse-backend.telangrocks.workers.dev").replace(/\/$/, "");
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...customConfig };

    this.metadata = {
      gitSha:          process.env.GITHUB_SHA || "local-dev-sha",
      branch:          process.env.GITHUB_REF_NAME || "main",
      workflowRunId:   process.env.GITHUB_RUN_ID || "local-run-1",
      buildTimestamp:  new Date().toISOString(),
      appVersion:      "1.0.0",
      validatorVersion: "3.0.0",
    };

    // ── Exchange resolution via registry ──────────────────────────────────────
    // resolveExchangeForContext() reads VALIDATION_EXCHANGE as an optional override
    // and falls back to the registry's LEVEL_DEFAULT_EXCHANGE for this level.
    // It throws a clear error if the exchange/level combination is unsupported.
    this.resolvedExchange     = resolveExchangeForContext(level);
    this.validationExchangeId = this.resolvedExchange.exchangeId;
    this.validationExchangeEnv = this.resolvedExchange.environment;

    // ── Credentials: ONLY populated for authenticated levels ──────────────────
    // Level 1 Public operates against public endpoints only — no credentials ever.
    const isAuthenticatedLevel = level === "level2_testnet" || level === "level3_prod_smoke";

    if (isAuthenticatedLevel && this.resolvedExchange.secretPrefix) {
      const prefix = this.resolvedExchange.secretPrefix;
      this.exchangeApiKey     = (process.env[`${prefix}_API_KEY`]        || "").trim();
      this.exchangeApiSecret  = (process.env[`${prefix}_API_SECRET`]     || "").trim();
      this.exchangePassphrase = (process.env[`${prefix}_API_PASSPHRASE`] || "").trim();
    }
    // For level1_public: exchangeApiKey, exchangeApiSecret, exchangePassphrase remain "" (default)

    // Register non-empty secrets for automatic log redaction
    if (this.exchangeApiKey)     SecurityRedactor.registerSecret(this.exchangeApiKey);
    if (this.exchangeApiSecret)  SecurityRedactor.registerSecret(this.exchangeApiSecret);
    if (this.exchangePassphrase) SecurityRedactor.registerSecret(this.exchangePassphrase);
    SecurityRedactor.registerSecret(process.env.QA_PASSWORD);
  }

  public recordEvidence(evidence: Omit<EmpiricalEvidence, "timestamp">): void {
    const record: EmpiricalEvidence = {
      timestamp: new Date().toISOString(),
      ...evidence,
      payload: evidence.payload ? SecurityRedactor.sanitizeObject(evidence.payload) : undefined,
    };
    this.empiricalLogs.push(record);
  }
}
