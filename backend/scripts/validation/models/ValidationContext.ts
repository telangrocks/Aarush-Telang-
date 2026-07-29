/**
 * Production Validation Framework — Execution Context & Empirical Collector
 */

import { ValidationSlaConfig, DEFAULT_VALIDATION_CONFIG } from "../config/ValidationConfig";
import { ValidationLevel } from "./ValidationPhase";
import { SecurityRedactor } from "../utils/SecurityRedactor";

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

  public exchangeApiKey: string = "";
  public exchangeApiSecret: string = "";
  public exchangePassphrase: string = "";
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
      gitSha: process.env.GITHUB_SHA || "local-dev-sha",
      branch: process.env.GITHUB_REF_NAME || "main",
      workflowRunId: process.env.GITHUB_RUN_ID || "local-run-1",
      buildTimestamp: new Date().toISOString(),
      appVersion: "1.0.0",
      validatorVersion: "3.0.0",
    };

    this.exchangeApiKey = (
      process.env.EXCHANGE_API_KEY ||
      process.env.QA_EXCHANGE_API_KEY ||
      "1tBQlwh2hqVr0ebRC8cPTZ0o7aJ0T2pPiMHmj1bof1iSuMJKUDBfumVv3o2oW4ey"
    ).trim();

    this.exchangeApiSecret = (
      process.env.EXCHANGE_API_SECRET ||
      process.env.QA_EXCHANGE_API_SECRET ||
      "hPHtVngddZwjvu7Mr3LMpsogaXelnDaDgf6bwxzWEyatorDBO1OFbyKh2qXty6Vk"
    ).trim();

    this.exchangePassphrase = (
      process.env.EXCHANGE_PASSPHRASE ||
      process.env.QA_EXCHANGE_PASSPHRASE ||
      ""
    ).trim();

    // Register secrets for redaction
    SecurityRedactor.registerSecret(this.exchangeApiKey);
    SecurityRedactor.registerSecret(this.exchangeApiSecret);
    SecurityRedactor.registerSecret(this.exchangePassphrase);
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
