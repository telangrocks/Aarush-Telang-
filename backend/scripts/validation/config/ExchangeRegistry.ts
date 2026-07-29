/**
 * Exchange Registry — Single Source of Truth
 *
 * This is the only file that needs to change when a new exchange is added.
 * No engine, context, or phase code requires modification.
 *
 * Adding a new exchange:
 *   1. Add an entry to SUPPORTED_EXCHANGES below.
 *   2. Add the corresponding GitHub Secrets ({PREFIX}_API_KEY, {PREFIX}_API_SECRET, etc.).
 *   3. Add the exchange ID to the workflow input options in core-job.yml.
 *   4. Done — the engine, context, and phases resolve everything automatically.
 */

export type ExchangeEnvironment = "testnet" | "mainnet";
export type ValidationLevel = "level1_public" | "level2_testnet" | "level3_prod_smoke";

export interface ExchangeEnvironmentConfig {
  /** Human-readable label for reports and diagnostics */
  displayLabel: string;
  /** Whether this exchange+environment requires a passphrase (API password) */
  requiresPassphrase: boolean;
  /**
   * Secret prefix used to compose GitHub Secrets / env var names.
   * e.g. "BINANCE_TESTNET" → reads BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_API_SECRET
   */
  secretPrefix: string;
  /**
   * Optional: name of an env var that overrides the base URL for this environment.
   * e.g. "BINANCE_TESTNET_URL" allows routing testnet traffic through a custom proxy.
   */
  baseUrlEnvVar?: string;
}

export interface ExchangeConfig {
  /** CCXT-compatible exchange ID — passed directly to ProviderFactory.create() */
  ccxtId: string;
  /** Human-readable display name for reports */
  displayName: string;
  /**
   * Supported environments for this exchange.
   * If an environment key is absent, that environment is not supported.
   * KuCoin has no testnet entry because their sandbox is officially deprecated.
   */
  environments: Partial<Record<ExchangeEnvironment, ExchangeEnvironmentConfig>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Level defaults — the ONLY place where level→exchange defaults are defined.
// The engine reads from here. Nothing else hardcodes these mappings.
// ─────────────────────────────────────────────────────────────────────────────

/** Default exchange per validation level. Overridable via VALIDATION_EXCHANGE env var. */
export const LEVEL_DEFAULT_EXCHANGE: Record<ValidationLevel, string> = {
  level1_public:     "binance",
  level2_testnet:    "binance",
  level3_prod_smoke: "kucoin",
};

/** Which exchange environment each validation level operates against. */
export const LEVEL_ENVIRONMENT: Record<ValidationLevel, ExchangeEnvironment> = {
  level1_public:     "mainnet",  // public endpoints — no auth
  level2_testnet:    "testnet",  // authenticated testnet sandbox
  level3_prod_smoke: "mainnet",  // production API — read-only, no orders
};

// ─────────────────────────────────────────────────────────────────────────────
// Exchange registry
// ─────────────────────────────────────────────────────────────────────────────

export const SUPPORTED_EXCHANGES: Record<string, ExchangeConfig> = {

  binance: {
    ccxtId: "binance",
    displayName: "Binance",
    environments: {
      mainnet: {
        displayLabel: "Binance Mainnet",
        requiresPassphrase: false,
        secretPrefix: "BINANCE_MAINNET",
      },
      testnet: {
        displayLabel: "Binance Testnet (Demo Net)",
        requiresPassphrase: false,
        secretPrefix: "BINANCE_TESTNET",
        baseUrlEnvVar: "BINANCE_TESTNET_URL",
      },
    },
  },

  kucoin: {
    ccxtId: "kucoin",
    displayName: "KuCoin",
    environments: {
      mainnet: {
        displayLabel: "KuCoin Mainnet",
        requiresPassphrase: true,
        secretPrefix: "KUCOIN_MAINNET",
      },
      // testnet: KuCoin officially deprecated their sandbox environment.
      // Add this entry if KuCoin reinstates testnet support in the future.
    },
  },

  // ─── Future exchanges — add one block below, zero engine changes required ──
  //
  // bybit: {
  //   ccxtId: "bybit",
  //   displayName: "Bybit",
  //   environments: {
  //     testnet: { displayLabel: "Bybit Testnet",  requiresPassphrase: false, secretPrefix: "BYBIT_TESTNET" },
  //     mainnet: { displayLabel: "Bybit Mainnet",  requiresPassphrase: false, secretPrefix: "BYBIT_MAINNET" },
  //   },
  // },
  //
  // okx: {
  //   ccxtId: "okx",
  //   displayName: "OKX",
  //   environments: {
  //     testnet: { displayLabel: "OKX Demo Trading", requiresPassphrase: true, secretPrefix: "OKX_TESTNET" },
  //     mainnet: { displayLabel: "OKX Mainnet",       requiresPassphrase: true, secretPrefix: "OKX_MAINNET" },
  //   },
  // },

};

// ─────────────────────────────────────────────────────────────────────────────
// Resolution helper
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedExchangeContext {
  exchangeId: string;
  displayName: string;
  ccxtId: string;
  environment: ExchangeEnvironment;
  envConfig: ExchangeEnvironmentConfig | undefined;
  secretPrefix: string | undefined;
  requiresPassphrase: boolean;
}

/**
 * Resolve the effective exchange and environment for a given validation level.
 *
 * Resolution order:
 *   1. VALIDATION_EXCHANGE env var (optional override — set via workflow input or CLI --exchange flag)
 *   2. LEVEL_DEFAULT_EXCHANGE registry default for the given level
 *
 * Throws with a clear, actionable error if:
 *  - The exchange ID is not in SUPPORTED_EXCHANGES.
 *  - The exchange does not support the required environment for this level
 *    (e.g. KuCoin has no testnet, so kucoin + level2_testnet is rejected).
 */
export function resolveExchangeForContext(level: ValidationLevel): ResolvedExchangeContext {
  const envOverride = (process.env.VALIDATION_EXCHANGE || "").trim().toLowerCase();
  const exchangeId  = envOverride || LEVEL_DEFAULT_EXCHANGE[level];
  const environment = LEVEL_ENVIRONMENT[level];

  const exchangeConfig = SUPPORTED_EXCHANGES[exchangeId];
  if (!exchangeConfig) {
    const registered = Object.keys(SUPPORTED_EXCHANGES).join(", ");
    throw new Error(
      `[ExchangeRegistry] Exchange "${exchangeId}" is not registered. ` +
      `Registered exchanges: ${registered}. ` +
      `Set VALIDATION_EXCHANGE to one of the registered exchanges, ` +
      `or leave it unset to use the level default (${LEVEL_DEFAULT_EXCHANGE[level]}).`
    );
  }

  const envConfig = exchangeConfig.environments[environment];
  const isAuthenticatedLevel = level === "level2_testnet" || level === "level3_prod_smoke";

  if (isAuthenticatedLevel && !envConfig) {
    const supported = Object.keys(exchangeConfig.environments).join(", ");
    throw new Error(
      `[ExchangeRegistry] Exchange "${exchangeId}" (${exchangeConfig.displayName}) ` +
      `does not support the "${environment}" environment required for "${level}". ` +
      `Supported environments: ${supported}.`
    );
  }

  return {
    exchangeId,
    displayName:        exchangeConfig.displayName,
    ccxtId:             exchangeConfig.ccxtId,
    environment,
    envConfig,
    secretPrefix:       envConfig?.secretPrefix,
    requiresPassphrase: envConfig?.requiresPassphrase ?? false,
  };
}
