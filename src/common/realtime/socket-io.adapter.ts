import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

/**
 * Socket.io adapter that takes its cross-origin policy from configuration
 * (spec 012 Story 3, FR-014/FR-016).
 *
 * Why an adapter rather than the `@WebSocketGateway({ cors })` decorator: the
 * decorator's options are evaluated when the module graph is built, before
 * Nest's DI container exists, so it cannot read `ConfigService`. The same
 * constraint is documented in `files.constants.ts` for Multer. An adapter runs
 * after the container is up and can read config properly — and it is also the
 * seam the cross-instance Redis adapter will attach to in Story 9, so one
 * mechanism covers both.
 *
 * ⚠ What this replaces is a SECOND cross-origin defect, and it is the opposite
 * of the one the spec set out to fix. The REST API granted CORS only OUTSIDE
 * production, so the dashboard was blocked in production. Meanwhile
 * `TrackingGateway` was declared `cors: { origin: '*' }` — a hardcoded wildcard
 * active in EVERY environment, production included. Fixing only the REST side
 * would have left the more permissive of the two in place. Both now read the
 * same config value, so they cannot drift apart.
 */
export class AppIoAdapter extends IoAdapter {
  private readonly allowedOrigins: string[];

  constructor(app: INestApplicationContext) {
    super(app);
    this.allowedOrigins = app.get(ConfigService).get<string[]>('cors.allowedOrigins') ?? [];
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.allowedOrigins,
        credentials: true,
      },
    });
  }
}
