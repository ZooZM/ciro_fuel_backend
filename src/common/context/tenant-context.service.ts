import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantContext } from '../interfaces/tenant-context.interface';
import { UserRole } from '../enums/user-role.enum';

/**
 * Request-scoped tenant context backed by AsyncLocalStorage rather than
 * Nest's REQUEST-scoped DI, so ordinary singleton providers (services used
 * from HTTP, WebSocket gateways, and BullMQ processors alike) can all read
 * the current actor without being forced into request scope themselves.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  run<T>(context: TenantContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  getContext(): TenantContext | undefined {
    return this.storage.getStore();
  }

  getCompanyId(): string | undefined {
    return this.storage.getStore()?.companyId;
  }

  getUserId(): string | undefined {
    return this.storage.getStore()?.userId;
  }

  getRole(): UserRole | undefined {
    return this.storage.getStore()?.role;
  }

  isSuperAdmin(): boolean {
    return this.storage.getStore()?.role === UserRole.SUPER_ADMIN;
  }
}
