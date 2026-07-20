import { UserRole } from '../enums/user-role.enum';

export interface JwtPayload {
  sub: string;
  role: UserRole;
  companyId?: string;
}

export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
  companyId?: string;
}
