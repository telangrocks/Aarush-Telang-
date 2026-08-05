import { Result, ok, fail, createDomainError, DomainError } from '../../domain/types/Result';
import { SecurityPolicy, ExchangePermissionSet, ExchangeCapability, EnvironmentMode } from './SecurityPolicy';

export class PermissionValidator {
  public static validatePermission(
    userPermissions: ExchangePermissionSet,
    requiredCapability: ExchangeCapability,
    targetEnvironment: EnvironmentMode
  ): Result<void, DomainError> {
    const decision = SecurityPolicy.canExecuteCapability(userPermissions, requiredCapability, targetEnvironment);

    if (!decision.allowed) {
      return fail(createDomainError('AUTHENTICATION_FAILED', decision.reason || 'Permission validation failed.'));
    }

    return ok(undefined);
  }
}
