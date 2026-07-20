import { UserRole } from '../enums/user-role.enum';

export interface TenantContext {
  userId: string;
  role: UserRole;
  companyId?: string;
}
