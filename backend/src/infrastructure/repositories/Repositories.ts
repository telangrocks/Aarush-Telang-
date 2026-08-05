export interface UserExchangeCredentials {
  readonly userId: string;
  readonly exchangeName: string;
  readonly environment: string;
  readonly apiKey: string;
  readonly encryptedSecret: string;
  readonly secretIv: string;
  readonly encryptedPassphrase?: string;
  readonly passphraseIv?: string;
}

export interface IExchangeRepository {
  getUserCredentials(userId: string): Promise<UserExchangeCredentials | null>;
  saveUserCredentials(credentials: UserExchangeCredentials): Promise<void>;
}

export class ExchangeRepository implements IExchangeRepository {
  constructor(private db?: any) {}

  public async getUserCredentials(userId: string): Promise<UserExchangeCredentials | null> {
    if (!this.db) return null;
    const row = await this.db.prepare(
      'SELECT exchange_name, exchange_environment, exchange_api_key, exchange_api_secret_encrypted, exchange_api_secret_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_iv FROM users WHERE id = ?'
    ).bind(userId).first();

    if (!row || !row.exchange_name || !row.exchange_api_key) return null;

    return {
      userId,
      exchangeName: row.exchange_name,
      environment: row.exchange_environment || 'mainnet',
      apiKey: row.exchange_api_key,
      encryptedSecret: row.exchange_api_secret_encrypted || '',
      secretIv: row.exchange_api_secret_iv || '',
      encryptedPassphrase: row.exchange_api_passphrase_encrypted,
      passphraseIv: row.exchange_api_passphrase_iv,
    };
  }

  public async saveUserCredentials(credentials: UserExchangeCredentials): Promise<void> {
    if (!this.db) return;
    await this.db.prepare(
      'UPDATE users SET exchange_name = ?, exchange_environment = ?, exchange_api_key = ?, exchange_api_secret_encrypted = ?, exchange_api_secret_iv = ?, exchange_api_passphrase_encrypted = ?, exchange_api_passphrase_iv = ? WHERE id = ?'
    ).bind(
      credentials.exchangeName,
      credentials.environment,
      credentials.apiKey,
      credentials.encryptedSecret,
      credentials.secretIv,
      credentials.encryptedPassphrase || null,
      credentials.passphraseIv || null,
      credentials.userId
    ).run();
  }
}
