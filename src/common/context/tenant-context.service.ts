import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantContext, RequestScope } from '../interfaces/tenant-context.interface';
import { UserRole } from '../enums/user-role.enum';

/**
 * Request-scoped tenant context backed by AsyncLocalStorage rather than
 * Nest's REQUEST-scoped DI, so ordinary singleton providers (services used
 * from HTTP, WebSocket gateways, and BullMQ processors alike) can all read
 * the current actor without being forced into request scope themselves.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<RequestScope>();

  run<T>(context: TenantContext, callback: () => T): T {
    // Carries the correlation id forward across a nested `run` (spec 012,
    // FR-029). The interceptor establishes the id first, on EVERY request
    // including anonymous ones, and only then — once a user is known —
    // establishes the actor; without this merge the second `run` would replace
    // the store and the request's own id would be lost at the exact moment it
    // becomes attributable to someone.
    const correlationId = this.storage.getStore()?.correlationId;
    return this.storage.run({ ...context, correlationId }, callback);
  }

  /**
   * Establishes a correlation id with NO actor — the state a public route
   * (login, refresh, the payment webhook) runs in, and the state a background
   * job runs in before it re-establishes one from job data (FR-030).
   *
   * Both scoping plugins treat "a store with no `role`" exactly as they treat
   * "no store at all": bypass. That equivalence is what makes establishing a
   * store on anonymous routes safe, and it is asserted by test — the
   * alternative reading, "a context is present therefore scope it", throws on
   * every login.
   */
  runWithCorrelationId<T>(correlationId: string, callback: () => T): T {
    return this.storage.run({ ...this.storage.getStore(), correlationId }, callback);
  }

  getCorrelationId(): string | undefined {
    return this.storage.getStore()?.correlationId;
  }

  /**
   * Runs `callback` with no active tenant context, so both scoping plugins
   * take their "no context" bypass path — the same one scripts/seeds/tests
   * already get outside a request. For trusted internal code that already
   * knows and validates the correct tenant for a cross-tenant write (e.g.
   * `NotificationsService.notify()` takes an explicit `companyId`), where
   * the ambient acting-user context would otherwise silently overwrite it —
   * this is the exact failure the two-step correction in
   * `CompaniesController.createTransporter` works around by hand; this is
   * the general form of that fix. `AsyncLocalStorage.run` nests cleanly, so
   * the caller's own context (if any) is restored once `callback` returns.
   */
  runUnscoped<T>(callback: () => T): T {
    // Drops the ACTOR, keeps the CORRELATION ID (spec 012). Storing `undefined`
    // outright — as this did before — silently dropped the correlation id too,
    // so the notification and rating writes that run through here would have
    // been precisely the records missing from an order's reconstructed
    // history. Both plugins bypass on the absent `role`, exactly as they did
    // on the absent store, so isolation behaviour is unchanged.
    const correlationId = this.storage.getStore()?.correlationId;
    return this.storage.run(correlationId ? { correlationId } : {}, callback);
  }

  getContext(): RequestScope | undefined {
    return this.storage.getStore();
  }

  getCompanyId(): string | undefined {
    return this.storage.getStore()?.companyId;
  }

  getParentFuelCompanyId(): string | undefined {
    return this.storage.getStore()?.parentFuelCompanyId;
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
