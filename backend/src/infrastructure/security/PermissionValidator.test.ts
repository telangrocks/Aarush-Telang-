import { describe, it, expect } from 'vitest';
import { PermissionValidator } from './PermissionValidator';
import { ExchangePermissionSet } from './SecurityPolicy';

describe('Milestone 3 — PermissionValidator & Capability Policy Unit Tests', () => {
  it('PermissionValidator allows authorized trading capability on matching environment', () => {
    const permissions: ExchangePermissionSet = {
      environment: 'mainnet',
      capabilities: new Set(['CAN_READ', 'CAN_TRADE', 'CAN_STREAM']),
    };

    const readRes = PermissionValidator.validatePermission(permissions, 'CAN_READ', 'mainnet');
    expect(readRes.isSuccess).toBe(true);

    const tradeRes = PermissionValidator.validatePermission(permissions, 'CAN_TRADE', 'mainnet');
    expect(tradeRes.isSuccess).toBe(true);
  });

  it('PermissionValidator rejects read-only credentials attempting CAN_TRADE capability', () => {
    const readOnlyPermissions: ExchangePermissionSet = {
      environment: 'mainnet',
      capabilities: new Set(['CAN_READ', 'CAN_STREAM']),
    };

    const tradeRes = PermissionValidator.validatePermission(readOnlyPermissions, 'CAN_TRADE', 'mainnet');
    expect(tradeRes.isFailure).toBe(true);
    if (tradeRes.isFailure) {
      expect(tradeRes.error.message).toContain("Missing required capability 'CAN_TRADE'");
    }
  });

  it('PermissionValidator enforces strict environment isolation (testnet vs mainnet)', () => {
    const testnetPermissions: ExchangePermissionSet = {
      environment: 'testnet',
      capabilities: new Set(['CAN_READ', 'CAN_TRADE']),
    };

    const mainnetAttempt = PermissionValidator.validatePermission(testnetPermissions, 'CAN_TRADE', 'mainnet');
    expect(mainnetAttempt.isFailure).toBe(true);
    if (mainnetAttempt.isFailure) {
      expect(mainnetAttempt.error.message).toContain('Environment mismatch');
    }
  });

  describe('Finding 4 — Least-Privilege Withdrawal Permission Enforcement', () => {
    it('1. Valid trading key without withdrawal permission is accepted (including official Bybit example with Wallet: ["AccountTransfer", "SubMemberTransfer"] and Exchange: ["ExchangeHistory"])', () => {
      const officialBybitPayload = {
        id: '13770661',
        note: 'Focus on trading',
        apiKey: 'XXXXXX',
        readOnly: 0,
        secret: '',
        permissions: {
          ContractTrade: ['Order', 'Position'],
          Spot: ['SpotTrade'],
          Wallet: ['AccountTransfer', 'SubMemberTransfer'],
          Options: ['OptionsTrade'],
          Derivatives: ['DerivativesTrade'],
          CopyTrading: ['CopyTrading'],
          BlockTrade: [],
          Exchange: ['ExchangeHistory'],
          NFT: ['NFTQueryProductList'],
          Affiliate: [],
        },
        ips: ['*'],
        type: 1,
        deadlineDay: -2,
        expiredAt: '1970-01-01T00:00:00Z',
        createdAt: '2022-10-16T02:24:40Z',
        unified: 0,
        uta: 0,
        userID: 24607703,
        inviterID: 0,
        vipLevel: 'No VIP',
        mktMakerLevel: '0',
        affiliateID: 0,
        rsaPublicKey: '',
        isMaster: true,
        parentUid: '0',
        kycLevel: 'LEVEL_DEFAULT',
        kycRegion: '',
      };

      const res = PermissionValidator.inspectBybitPermissions(officialBybitPayload, 'demo');

      expect(res.isValid).toBe(true);
      expect(res.readOnly).toBe(false);
      expect(res.hasTradingPermission).toBe(true);
      expect(res.hasWithdrawPermission).toBe(false);
      expect(res.withdrawalVerificationStatus).toBe('DISABLED');
      expect(res.errorCode).toBeUndefined();

      // Also verify SubMemberTransferList in Wallet and ExchangeHistory in Exchange are accepted as non-withdrawal
      const subMemberListRes = PermissionValidator.inspectBybitPermissions(
        {
          readOnly: 0,
          permissions: {
            ContractTrade: ['Order', 'Position'],
            Spot: ['SpotTrade'],
            Wallet: ['AccountTransfer', 'SubMemberTransfer', 'SubMemberTransferList'],
            Exchange: ['ExchangeHistory'],
          },
        },
        'mainnet'
      );
      expect(subMemberListRes.isValid).toBe(true);
      expect(subMemberListRes.hasTradingPermission).toBe(true);
      expect(subMemberListRes.hasWithdrawPermission).toBe(false);
      expect(subMemberListRes.withdrawalVerificationStatus).toBe('DISABLED');
      expect(subMemberListRes.errorCode).toBeUndefined();
    });

    it('2. Read-only key is rejected with READ_ONLY_API_KEY', () => {
      const res = PermissionValidator.inspectBybitPermissions(
        {
          readOnly: 1,
          permissions: {
            ContractTrade: ['Order', 'Position'],
            Wallet: [],
          },
        },
        'mainnet'
      );

      expect(res.isValid).toBe(true);
      expect(res.readOnly).toBe(true);
      expect(res.hasTradingPermission).toBe(false);
      expect(res.hasWithdrawPermission).toBe(false);
      expect(res.withdrawalVerificationStatus).toBe('DISABLED');
      expect(res.errorCode).toBe('READ_ONLY_API_KEY');
    });

    it('3. Key lacking required trading permissions is rejected with PERMISSION_DENIED', () => {
      const res = PermissionValidator.inspectBybitPermissions(
        {
          readOnly: 0,
          permissions: {
            ContractTrade: [],
            Spot: [],
            Wallet: ['AccountTransfer', 'SubMemberTransfer'],
            Exchange: ['ExchangeHistory'],
          },
        },
        'mainnet'
      );

      expect(res.isValid).toBe(true);
      expect(res.readOnly).toBe(false);
      expect(res.hasTradingPermission).toBe(false);
      expect(res.hasWithdrawPermission).toBe(false);
      expect(res.withdrawalVerificationStatus).toBe('DISABLED');
      expect(res.errorCode).toBe('PERMISSION_DENIED');
    });

    it('4. Key with explicit Wallet: ["Withdraw"] (alone or with transfer permissions) is rejected with WITHDRAWAL_PERMISSION_FORBIDDEN', () => {
      const onlyWithdrawRes = PermissionValidator.inspectBybitPermissions(
        {
          readOnly: 0,
          permissions: {
            ContractTrade: ['Order', 'Position'],
            Spot: ['SpotTrade'],
            Wallet: ['Withdraw'],
            Exchange: ['ExchangeHistory'],
          },
        },
        'mainnet'
      );

      expect(onlyWithdrawRes.isValid).toBe(false);
      expect(onlyWithdrawRes.hasWithdrawPermission).toBe(true);
      expect(onlyWithdrawRes.withdrawalVerificationStatus).toBe('ENABLED');
      expect(onlyWithdrawRes.errorCode).toBe('WITHDRAWAL_PERMISSION_FORBIDDEN');

      const combinedWithdrawRes = PermissionValidator.inspectBybitPermissions(
        {
          readOnly: 0,
          permissions: {
            ContractTrade: ['Order', 'Position'],
            Wallet: ['AccountTransfer', 'SubMemberTransfer', 'Withdraw'],
          },
        },
        'demo'
      );

      expect(combinedWithdrawRes.isValid).toBe(false);
      expect(combinedWithdrawRes.hasWithdrawPermission).toBe(true);
      expect(combinedWithdrawRes.withdrawalVerificationStatus).toBe('ENABLED');
      expect(combinedWithdrawRes.errorCode).toBe('WITHDRAWAL_PERMISSION_FORBIDDEN');
    });

    it('5. Missing, null, empty, or unrecognized permission structure fails safely with PERMISSION_VERIFICATION_FAILED', () => {
      // Missing permissions field
      const missingRes = PermissionValidator.inspectBybitPermissions({ readOnly: 0 }, 'demo');
      expect(missingRes.isValid).toBe(false);
      expect(missingRes.withdrawalVerificationStatus).toBe('MISSING_FIELD');
      expect(missingRes.errorCode).toBe('PERMISSION_VERIFICATION_FAILED');

      // Null permissions field
      const nullRes = PermissionValidator.inspectBybitPermissions({ readOnly: 0, permissions: null }, 'demo');
      expect(nullRes.isValid).toBe(false);
      expect(nullRes.withdrawalVerificationStatus).toBe('NULL_FIELD');
      expect(nullRes.errorCode).toBe('PERMISSION_VERIFICATION_FAILED');

      // Empty permissions object
      const emptyRes = PermissionValidator.inspectBybitPermissions({ readOnly: 0, permissions: {} }, 'demo');
      expect(emptyRes.isValid).toBe(false);
      expect(emptyRes.withdrawalVerificationStatus).toBe('UNRECOGNIZED');
      expect(emptyRes.errorCode).toBe('PERMISSION_VERIFICATION_FAILED');

      // Missing Wallet array
      const noWalletRes = PermissionValidator.inspectBybitPermissions(
        { readOnly: 0, permissions: { ContractTrade: ['Order'] } },
        'mainnet'
      );
      expect(noWalletRes.isValid).toBe(false);
      expect(noWalletRes.withdrawalVerificationStatus).toBe('UNRECOGNIZED');
      expect(noWalletRes.errorCode).toBe('PERMISSION_VERIFICATION_FAILED');

      // Unrecognized category or Wallet token
      const unknownTokenRes = PermissionValidator.inspectBybitPermissions(
        { readOnly: 0, permissions: { ContractTrade: ['Order'], Wallet: ['MysteryTransferMode'] } },
        'mainnet'
      );
      expect(unknownTokenRes.isValid).toBe(false);
      expect(unknownTokenRes.withdrawalVerificationStatus).toBe('UNRECOGNIZED');
      expect(unknownTokenRes.errorCode).toBe('PERMISSION_VERIFICATION_FAILED');
    });
  });
});
