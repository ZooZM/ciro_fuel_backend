import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';

function buildContext(user?: { role: UserRole }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  it('allows access when no @Roles() metadata is present (auth-only route)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const ctx = buildContext({ role: UserRole.CLIENT });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows access when the user role is in the required list', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.FUEL_COMPANY_ADMIN]);
    const ctx = buildContext({ role: UserRole.FUEL_COMPANY_ADMIN });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies access when the user role is not in the required list', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.FUEL_COMPANY_ADMIN]);
    const ctx = buildContext({ role: UserRole.CLIENT });
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('denies access when there is no authenticated user at all', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.FUEL_COMPANY_ADMIN]);
    const ctx = buildContext(undefined);
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('respects the metadata key used by the @Roles() decorator', () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([UserRole.DRIVER]);
    const ctx = buildContext({ role: UserRole.DRIVER });
    guard.canActivate(ctx);
    expect(spy.mock.calls[0][0]).toBe(ROLES_KEY);
  });
});
