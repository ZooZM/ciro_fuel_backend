import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../enums/user-role.enum';

export const ROLES_KEY = 'roles';

/** Restricts a route to the given roles; enforced by the global RolesGuard. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
