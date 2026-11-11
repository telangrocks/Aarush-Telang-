export type ExchangeCapability =
  | 'CAN_READ'
  | 'CAN_TRADE'
  | 'CAN_WITHDRAW'
  | 'CAN_MANAGE_API'
  | 'CAN_STREAM'
  | 'CAN_ADMIN';

export type EnvironmentMode = 'mainnet' | 'demo' | 'testnet' | 'sandbox';

export interface ExchangePermissionSet {
  readonly environment: EnvironmentMode;
  readonly capabilities: ReadonlySet<ExchangeCapability>;
  readonly isIpRestricted?: boolean;
  readonly allowedIps?: string[];
}

export class SecurityPolicy {
  public static canExecuteCapability(
    userPermissions: ExchangePermissionSet,
    requiredCapability: ExchangeCapability,
    targetEnvironment: EnvironmentMode
  ): { allowed: boolean; reason?: string } {
    // 1. Environment Policy Check: Sandbox/Testnet/Demo keys cannot cross environments
    if (userPermissions.environment !== targetEnvironment) {
      return {
        allowed: false,
        reason: `Environment mismatch: Credential environment '${userPermissions.environment}' cannot operate on target environment '${targetEnvironment}'.`,
      };
    }

    // 2. Least-Privilege Policy Check: Withdrawal permission is strictly forbidden
    if (userPermissions.capabilities.has('CAN_WITHDRAW')) {
      return {
        allowed: false,
        reason: `Least-privilege security violation: API keys with withdrawal permission ('CAN_WITHDRAW') are forbidden. CryptoPulse never requires withdrawal access.`,
      };
    }

    // 3. Capability Policy Check
    if (!userPermissions.capabilities.has(requiredCapability)) {
      return {
        allowed: false,
        reason: `Missing required capability '${requiredCapability}'. Granted capabilities: [${Array.from(userPermissions.capabilities).join(', ')}].`,
      };
    }

    return { allowed: true };
  }
}
