import { CredentialState } from './SecretManager';
import { ExchangePermissionSet } from './SecurityPolicy';

export class SecurityState {
  private constructor(
    readonly credentialStatus: ReadonlyMap<string, CredentialState>,
    readonly lastRotationTime: ReadonlyMap<string, number>,
    readonly permissionStatus: ReadonlyMap<string, ExchangePermissionSet>,
    readonly securityViolationsCount: number,
    readonly cacheIsolationActive: boolean,
    readonly isSecurityHealthy: boolean
  ) {}

  public static createDefault(): SecurityState {
    return new SecurityState(new Map(), new Map(), new Map(), 0, true, true);
  }

  public withCredentialStatus(key: string, state: CredentialState): SecurityState {
    const updated = new Map(this.credentialStatus);
    updated.set(key, state);
    return new SecurityState(
      updated,
      this.lastRotationTime,
      this.permissionStatus,
      this.securityViolationsCount,
      this.cacheIsolationActive,
      this.isSecurityHealthy
    );
  }

  public withRotation(key: string, timestamp: number): SecurityState {
    const updated = new Map(this.lastRotationTime);
    updated.set(key, timestamp);
    return new SecurityState(
      this.credentialStatus,
      updated,
      this.permissionStatus,
      this.securityViolationsCount,
      this.cacheIsolationActive,
      this.isSecurityHealthy
    );
  }

  public withViolation(): SecurityState {
    const newCount = this.securityViolationsCount + 1;
    return new SecurityState(
      this.credentialStatus,
      this.lastRotationTime,
      this.permissionStatus,
      newCount,
      this.cacheIsolationActive,
      newCount < 10 // Degrades if > 10 security violations occur
    );
  }
}
