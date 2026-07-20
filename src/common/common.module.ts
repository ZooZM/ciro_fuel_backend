import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { TenantContextService } from './context/tenant-context.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TenantIsolationInterceptor } from './interceptors/tenant-isolation.interceptor';

/**
 * Global module: TenantContextService must be a single shared singleton
 * instance across the whole app — it's injected both by the Mongoose
 * connectionFactory (app.module.ts) and by TenantIsolationInterceptor below,
 * and both must read/write the exact same AsyncLocalStorage.
 *
 * Guard order matters: Throttler -> Jwt (authenticates, populates req.user)
 * -> Roles (reads req.user set by Jwt). Nest runs APP_GUARD providers in
 * registration order.
 */
@Global()
@Module({
  providers: [
    TenantContextService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantIsolationInterceptor },
  ],
  exports: [TenantContextService],
})
export class CommonModule {}
