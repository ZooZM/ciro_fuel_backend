import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { TenantContextService } from '../context/tenant-context.service';
import {
  CORRELATION_ID_HEADER,
  LOG_CONTEXT_KEY,
  RequestLogContext,
} from '../logging/pino.config';
import { AuthenticatedUser } from '../interfaces/jwt-payload.interface';

@Injectable()
export class TenantIsolationInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      id?: string;
      headers?: Record<string, string | string[] | undefined>;
      [LOG_CONTEXT_KEY]?: RequestLogContext;
    }>();
    const user = request.user;

    // One id for the request and for every background job it causes (spec 012
    // FR-029/FR-030). An inbound header is honoured so a trace that started at
    // the proxy or in another service continues rather than restarting here;
    // `req.id` is what pino-http already generated for this request, and
    // reusing it is what keeps the framework's own record and the application's
    // records joinable. Only when neither exists is a fresh one minted.
    const correlationId =
      (request.headers?.[CORRELATION_ID_HEADER] as string | undefined) ??
      request.id ??
      randomUUID();

    // Stashed on `req` as well as established in the store, because pino-http
    // emits its per-request record from `res.on('finish')` — outside this
    // scope, where the store is already gone (see LOG_CONTEXT_KEY).
    request[LOG_CONTEXT_KEY] = {
      correlationId,
      userId: user?.userId,
      companyId: user?.companyId,
      role: user?.role,
    };

    if (!user) {
      // Public routes (login, refresh, payment webhook) run with NO ACTOR — but
      // since spec 012 they do run with a store, so their records carry a
      // correlation id like every other request's. Both Mongoose plugins bypass
      // on the absent `role`, which is exactly what they did before when no
      // store existed at all; `runWithCorrelationId` is where that equivalence
      // is documented.
      return new Observable((subscriber) =>
        this.tenantContext.runWithCorrelationId(correlationId, () => {
          const subscription = next.handle().subscribe(subscriber);
          return () => subscription.unsubscribe();
        }),
      );
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
      return this.tenantContext.runWithCorrelationId(correlationId, () =>
        this.tenantContext.run(
          {
            userId: user.userId,
            role: user.role,
            companyId: user.companyId,
            parentFuelCompanyId: user.parentFuelCompanyId,
          },
          () => {
            const subscription = next.handle().subscribe(subscriber);
            return () => subscription.unsubscribe();
          },
        ),
      );
    });
  }
}
