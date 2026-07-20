import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextService } from '../context/tenant-context.service';
import { AuthenticatedUser } from '../interfaces/jwt-payload.interface';

@Injectable()
export class TenantIsolationInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user) {
      // Public routes (login, refresh, payment webhook) run with no tenant context;
      // the Mongoose plugin treats "no context" as bypass, which is correct there.
      return next.handle();
    }

    // IMPORTANT: next.handle() returns a lazily-subscribed Observable — merely
    // calling it inside tenantContext.run() would NOT propagate AsyncLocalStorage
    // to the controller, because the controller only actually executes when
    // something subscribes, and Nest subscribes *after* this method returns.
    // Wrapping construction+subscription together inside a `new Observable`
    // executor ensures the subscribe() call — and therefore the controller
    // invocation and everything it awaits — happens synchronously inside
    // tenantContext.run(), so AsyncLocalStorage correctly threads through.
    return new Observable((subscriber) => {
      return this.tenantContext.run(
        { userId: user.userId, role: user.role, companyId: user.companyId },
        () => {
          const subscription = next.handle().subscribe(subscriber);
          return () => subscription.unsubscribe();
        },
      );
    });
  }
}
