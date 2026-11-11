import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';
import { SecurityPolicy, ExchangePermissionSet, ExchangeCapability, EnvironmentMode } from './SecurityPolicy';
import { normalizeEnvironment } from '../../utils/environment';

export type WithdrawalVerificationStatus =
  | 'DISABLED'
  | 'ENABLED'
  | 'MISSING_FIELD'
  | 'NULL_FIELD'
  | 'UNRECOGNIZED';

export interface BybitPermissionInspectionResult {
  readonly isValid: boolean;
  readonly readOnly: boolean;
  readonly hasTradingPermission: boolean;
  readonly hasWithdrawPermission: boolean;
  readonly withdrawalVerificationStatus: WithdrawalVerificationStatus;
  readonly permissions: Record<string, string[]>;
  readonly errorCode?: 'WITHDRAWAL_PERMISSION_FORBIDDEN' | 'PERMISSION_VERIFICATION_FAILED' | 'READ_ONLY_API_KEY' | 'PERMISSION_DENIED' | 'INVALID_ENVIRONMENT';
  readonly errorMessage?: string;
}

const KNOWN_BYBIT_PERMISSION_CATEGORIES = new Set([
  'ContractTrade',
  'Spot',
  'Wallet',
  'Options',
  'Derivatives',
  'CopyTrading',
  'BlockTrade',
  'Exchange',
  'NFT',
  'Affiliate',
  'Earn',
  'FiatP2P',
  'BybitPay',
]);

/**
 * Official Bybit V5 `/v5/user/query-api` Wallet permission values:
 * - "AccountTransfer": Account transfer (not withdrawal)
 * - "SubMemberTransfer": Sub-account transfer (not withdrawal)
 * - "SubMemberTransferList": Sub-account transfer list query (not withdrawal)
 * - "Withdraw": On-chain / external withdrawal permission (FORBIDDEN by least-privilege policy)
 * Note: Convert permission is represented under `permissions.Exchange` as `"ExchangeHistory"`, not withdrawal.
 */
const KNOWN_BYBIT_WALLET_PERMISSIONS = new Set([
  'AccountTransfer',
  'SubMemberTransfer',
  'SubMemberTransferList',
  'Withdraw',
]);

export class PermissionValidator {
  public static validatePermission(
    userPermissions: ExchangePermissionSet,
    requiredCapability: ExchangeCapability,
    targetEnvironment: EnvironmentMode
  ): Result<void, DomainError> {
    const decision = SecurityPolicy.canExecuteCapability(userPermissions, requiredCapability, targetEnvironment);

    if (!decision.allowed) {
      const code = userPermissions.capabilities.has('CAN_WITHDRAW')
        ? 'WITHDRAWAL_PERMISSION_FORBIDDEN'
        : 'AUTHENTICATION_FAILED';
      return fail(createDomainError(code, decision.reason || 'Permission validation failed.'));
    }

    return ok(undefined);
  }

  /**
   * Strictly inspects and validates a Bybit V5 `/v5/user/query-api` response payload.
   * Never treats missing, null, or unrecognized permission structures as proof that withdrawal is disabled.
   */
  public static inspectBybitPermissions(
    rawPayload: unknown,
    targetEnvironmentInput: unknown
  ): BybitPermissionInspectionResult {
    const canonicalEnv = normalizeEnvironment(targetEnvironmentInput);
    if (!canonicalEnv) {
      return {
        isValid: false,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'UNRECOGNIZED',
        permissions: {},
        errorCode: 'INVALID_ENVIRONMENT',
        errorMessage: `Invalid or missing exchange environment: '${String(targetEnvironmentInput ?? '')}'.`,
      };
    }

    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return {
        isValid: false,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'UNRECOGNIZED',
        permissions: {},
        errorCode: 'PERMISSION_VERIFICATION_FAILED',
        errorMessage: 'Bybit permission response is missing or malformed.',
      };
    }

    const payloadObj = rawPayload as Record<string, any>;
    const target: Record<string, any> =
      'result' in payloadObj &&
      payloadObj.result &&
      typeof payloadObj.result === 'object' &&
      !Array.isArray(payloadObj.result) &&
      !('permissions' in payloadObj) &&
      !('readOnly' in payloadObj)
        ? payloadObj.result
        : payloadObj;

    if (!('permissions' in target) || target.permissions === undefined) {
      return {
        isValid: false,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'MISSING_FIELD',
        permissions: {},
        errorCode: 'PERMISSION_VERIFICATION_FAILED',
        errorMessage: 'Bybit API key permission check failed: permissions field is missing from /v5/user/query-api response.',
      };
    }

    if (target.permissions === null) {
      return {
        isValid: false,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'NULL_FIELD',
        permissions: {},
        errorCode: 'PERMISSION_VERIFICATION_FAILED',
        errorMessage: 'Bybit API key permission check failed: permissions field is null in /v5/user/query-api response.',
      };
    }

    const rawPerms = target.permissions;
    if (typeof rawPerms !== 'object' || Array.isArray(rawPerms)) {
      return {
        isValid: false,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'UNRECOGNIZED',
        permissions: {},
        errorCode: 'PERMISSION_VERIFICATION_FAILED',
        errorMessage: 'Bybit API key permission check failed: permissions field has an unrecognized representation.',
      };
    }

    const permEntries = Object.entries(rawPerms as Record<string, unknown>);
    if (permEntries.length === 0) {
      return {
        isValid: false,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'UNRECOGNIZED',
        permissions: {},
        errorCode: 'PERMISSION_VERIFICATION_FAILED',
        errorMessage: 'Bybit API key permission check failed: permissions object is empty and cannot establish withdrawal status.',
      };
    }

    for (const [category, val] of permEntries) {
      if (!KNOWN_BYBIT_PERMISSION_CATEGORIES.has(category)) {
        return {
          isValid: false,
          readOnly: false,
          hasTradingPermission: false,
          hasWithdrawPermission: false,
          withdrawalVerificationStatus: 'UNRECOGNIZED',
          permissions: {},
          errorCode: 'PERMISSION_VERIFICATION_FAILED',
          errorMessage: `Bybit API key permission check encountered unrecognized permission category '${category}'.`,
        };
      }
      if (!Array.isArray(val) || val.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
        return {
          isValid: false,
          readOnly: false,
          hasTradingPermission: false,
          hasWithdrawPermission: false,
          withdrawalVerificationStatus: 'UNRECOGNIZED',
          permissions: {},
          errorCode: 'PERMISSION_VERIFICATION_FAILED',
          errorMessage: `Bybit API key permission check encountered malformed permission array for category '${category}'.`,
        };
      }
    }

    if (!('Wallet' in rawPerms) || !Array.isArray((rawPerms as any).Wallet)) {
      return {
        isValid: false,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'UNRECOGNIZED',
        permissions: {},
        errorCode: 'PERMISSION_VERIFICATION_FAILED',
        errorMessage: 'Bybit API key permission check could not reliably establish withdrawal permission: Wallet permission array is missing.',
      };
    }

    const walletPerms: string[] = (rawPerms as any).Wallet;
    for (const wp of walletPerms) {
      const cleanedWp = wp.trim();
      if (!KNOWN_BYBIT_WALLET_PERMISSIONS.has(cleanedWp)) {
        return {
          isValid: false,
          readOnly: false,
          hasTradingPermission: false,
          hasWithdrawPermission: false,
          withdrawalVerificationStatus: 'UNRECOGNIZED',
          permissions: {},
          errorCode: 'PERMISSION_VERIFICATION_FAILED',
          errorMessage: `Bybit API key permission check encountered unrecognized Wallet permission '${wp}'.`,
        };
      }
    }

    const rawReadOnly = target.readOnly;
    if (
      rawReadOnly !== undefined &&
      rawReadOnly !== null &&
      rawReadOnly !== 0 &&
      rawReadOnly !== 1 &&
      rawReadOnly !== '0' &&
      rawReadOnly !== '1' &&
      rawReadOnly !== true &&
      rawReadOnly !== false
    ) {
      return {
        isValid: false,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'UNRECOGNIZED',
        permissions: {},
        errorCode: 'PERMISSION_VERIFICATION_FAILED',
        errorMessage: 'Bybit API key permission check encountered unrecognized readOnly flag representation.',
      };
    }

    const isReadOnly = rawReadOnly === 1 || rawReadOnly === '1' || rawReadOnly === true;
    const typedPerms = rawPerms as Record<string, string[]>;

    // Official Bybit /v5/user/query-api withdrawal check:
    // Exact "Withdraw" in permissions.Wallet means withdrawal permission is enabled.
    // "AccountTransfer" and "SubMemberTransfer" (in Wallet) and "ExchangeHistory" (in Exchange) are NOT withdrawal permissions.
    const hasWithdrawPermission = walletPerms.some((p) => p.trim() === 'Withdraw');

    const contractTrade: string[] = Array.isArray(typedPerms.ContractTrade) ? typedPerms.ContractTrade : [];
    const spotTrade: string[] = Array.isArray(typedPerms.Spot) ? typedPerms.Spot : [];
    const derivativesTrade: string[] = Array.isArray(typedPerms.Derivatives) ? typedPerms.Derivatives : [];

    const hasContractOrder = contractTrade.some((p) => {
      const lower = p.trim().toLowerCase();
      return lower === 'order' || lower === 'orders' || lower === 'position' || lower === 'positions';
    });
    const hasSpotOrder = spotTrade.some((p) => {
      const lower = p.trim().toLowerCase();
      return lower === 'spottrade' || lower === 'order';
    });
    const hasDerivativesOrder = derivativesTrade.some((p) => {
      const lower = p.trim().toLowerCase();
      return lower === 'order' || lower === 'derivativestrade';
    });

    const hasTradingPermission = !isReadOnly && (hasContractOrder || hasSpotOrder || hasDerivativesOrder);

    const capabilities = new Set<ExchangeCapability>(['CAN_READ']);
    if (hasTradingPermission) {
      capabilities.add('CAN_TRADE');
    }
    if (hasWithdrawPermission) {
      capabilities.add('CAN_WITHDRAW');
    }

    const permissionSet: ExchangePermissionSet = {
      environment: canonicalEnv,
      capabilities,
    };

    const policyDecision = this.validatePermission(permissionSet, 'CAN_TRADE', canonicalEnv);

    if (hasWithdrawPermission) {
      return {
        isValid: false,
        readOnly: isReadOnly,
        hasTradingPermission,
        hasWithdrawPermission: true,
        withdrawalVerificationStatus: 'ENABLED',
        permissions: typedPerms,
        errorCode: 'WITHDRAWAL_PERMISSION_FORBIDDEN',
        errorMessage:
          policyDecision.isFailure
            ? policyDecision.error.message
            : "Least-privilege security violation: API keys with withdrawal permission ('CAN_WITHDRAW') are forbidden.",
      };
    }

    if (isReadOnly) {
      return {
        isValid: true,
        readOnly: true,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'DISABLED',
        permissions: typedPerms,
        errorCode: 'READ_ONLY_API_KEY',
        errorMessage: 'Your Bybit API key is Read-Only. Trading permissions are required.',
      };
    }

    if (!hasTradingPermission || policyDecision.isFailure) {
      return {
        isValid: true,
        readOnly: false,
        hasTradingPermission: false,
        hasWithdrawPermission: false,
        withdrawalVerificationStatus: 'DISABLED',
        permissions: typedPerms,
        errorCode: 'PERMISSION_DENIED',
        errorMessage:
          policyDecision.isFailure
            ? policyDecision.error.message
            : 'Access denied. Your API key does not have the necessary trading permissions.',
      };
    }

    return {
      isValid: true,
      readOnly: false,
      hasTradingPermission: true,
      hasWithdrawPermission: false,
      withdrawalVerificationStatus: 'DISABLED',
      permissions: typedPerms,
    };
  }
}
