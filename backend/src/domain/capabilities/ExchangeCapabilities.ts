export interface CapabilityVersion {
  readonly major: number;
  readonly minor: number;
}

export interface ExchangeCapabilities {
  readonly version: CapabilityVersion;
  readonly supportsOco: boolean;
  readonly supportsSandbox: boolean;
  readonly supportsMargin: boolean;
  readonly supportsFutures: boolean;
  readonly supportsTrailingStop: boolean;
  readonly supportsMarketBuyRequiresPrice: boolean;
  readonly supportsTimeSync: boolean;
  readonly requiresPassphrase: boolean;
  readonly supportsNativeProxy: boolean;
  readonly advancedOrderTypes: {
    readonly supportsTwap: boolean;
    readonly supportsIceberg: boolean;
    readonly supportsTrailingDelta: boolean;
    readonly supportsSelfTradePrevention: boolean;
  };
}

export const DEFAULT_CAPABILITIES: ExchangeCapabilities = {
  version: { major: 1, minor: 0 },
  supportsOco: false,
  supportsSandbox: false,
  supportsMargin: false,
  supportsFutures: false,
  supportsTrailingStop: false,
  supportsMarketBuyRequiresPrice: false,
  supportsTimeSync: true,
  requiresPassphrase: false,
  supportsNativeProxy: false,
  advancedOrderTypes: {
    supportsTwap: false,
    supportsIceberg: false,
    supportsTrailingDelta: false,
    supportsSelfTradePrevention: false,
  },
};
