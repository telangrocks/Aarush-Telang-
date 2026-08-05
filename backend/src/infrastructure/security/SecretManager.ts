import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';

export type CredentialState = 'UNVALIDATED' | 'ACTIVE' | 'ROTATING' | 'EXPIRED' | 'REVOKED' | 'ARCHIVED';

export interface CredentialRecord {
  readonly userId: string;
  readonly exchangeId: string;
  readonly environment: string;
  readonly version: number;
  readonly state: CredentialState;
  readonly apiKey: string;
  readonly encryptedSecret: string;
  readonly secretIv: string;
  readonly encryptedPassphrase?: string;
  readonly passphraseIv?: string;
  readonly expiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ISecretProvider {
  getCredential(userId: string, exchangeId: string, environment?: string): Promise<Result<CredentialRecord, DomainError>>;
  saveCredential(record: CredentialRecord): Promise<Result<void, DomainError>>;
}

export class SecretManager {
  private credentials = new Map<string, CredentialRecord>();

  private getMapKey(userId: string, exchangeId: string, environment: string = 'mainnet'): string {
    return `${userId}:${exchangeId}:${environment}`;
  }

  public registerCredential(
    userId: string,
    exchangeId: string,
    apiKey: string,
    encryptedSecret: string,
    secretIv: string,
    environment: string = 'mainnet',
    encryptedPassphrase?: string,
    passphraseIv?: string,
    ttlMs?: number
  ): Result<CredentialRecord> {
    if (!userId || !exchangeId || !apiKey || !encryptedSecret) {
      return fail(createDomainError('VALIDATION_FAILED', 'User ID, exchange ID, API key, and encrypted secret are required.'));
    }

    const mapKey = this.getMapKey(userId, exchangeId, environment);
    const existing = this.credentials.get(mapKey);
    const version = existing ? existing.version + 1 : 1;
    const now = Date.now();

    const record: CredentialRecord = {
      userId,
      exchangeId,
      environment,
      version,
      state: 'ACTIVE',
      apiKey: apiKey.trim(),
      encryptedSecret,
      secretIv,
      encryptedPassphrase,
      passphraseIv,
      expiresAt: ttlMs ? now + ttlMs : undefined,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.credentials.set(mapKey, record);
    return ok(record);
  }

  public getActiveCredential(userId: string, exchangeId: string, environment: string = 'mainnet'): Result<CredentialRecord> {
    const mapKey = this.getMapKey(userId, exchangeId, environment);
    const record = this.credentials.get(mapKey);

    if (!record) {
      return fail(createDomainError('NOT_FOUND', `No credential record found for user ${userId} on ${exchangeId} (${environment}).`));
    }

    if (record.state === 'REVOKED' || record.state === 'ARCHIVED') {
      return fail(createDomainError('AUTHENTICATION_FAILED', `Credential for ${exchangeId} is ${record.state}.`));
    }

    if (record.expiresAt && Date.now() > record.expiresAt) {
      const expiredRecord: CredentialRecord = { ...record, state: 'EXPIRED', updatedAt: Date.now() };
      this.credentials.set(mapKey, expiredRecord);
      return fail(createDomainError('AUTHENTICATION_FAILED', `Credential for ${exchangeId} has EXPIRED.`));
    }

    return ok(record);
  }

  public rotateCredential(
    userId: string,
    exchangeId: string,
    newApiKey: string,
    newEncryptedSecret: string,
    newSecretIv: string,
    environment: string = 'mainnet',
    newEncryptedPassphrase?: string,
    newPassphraseIv?: string
  ): Result<CredentialRecord> {
    const existingRes = this.getActiveCredential(userId, exchangeId, environment);
    const mapKey = this.getMapKey(userId, exchangeId, environment);

    const oldVersion = existingRes.isSuccess ? existingRes.value.version : 0;
    const now = Date.now();

    const newRecord: CredentialRecord = {
      userId,
      exchangeId,
      environment,
      version: oldVersion + 1,
      state: 'ACTIVE',
      apiKey: newApiKey.trim(),
      encryptedSecret: newEncryptedSecret,
      secretIv: newSecretIv,
      encryptedPassphrase: newEncryptedPassphrase,
      passphraseIv: newPassphraseIv,
      createdAt: existingRes.isSuccess ? existingRes.value.createdAt : now,
      updatedAt: now,
    };

    this.credentials.set(mapKey, newRecord);
    return ok(newRecord);
  }

  public revokeCredential(userId: string, exchangeId: string, environment: string = 'mainnet'): Result<void> {
    const mapKey = this.getMapKey(userId, exchangeId, environment);
    const record = this.credentials.get(mapKey);
    if (!record) {
      return fail(createDomainError('NOT_FOUND', 'Credential record not found for revocation.'));
    }

    const revoked: CredentialRecord = { ...record, state: 'REVOKED', updatedAt: Date.now() };
    this.credentials.set(mapKey, revoked);
    return ok(undefined);
  }
}
