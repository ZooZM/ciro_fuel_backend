import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

/**
 * A thin, dependency-free bridge between the Socket.io server (owned by
 * TrackingGateway) and every OTHER service that needs to push a realtime
 * event (OrderStateService, OtpService, NotificationsService). Those
 * services live in leaf modules (OrderCoreModule, NotificationsModule) that
 * must NOT depend on TrackingModule (which needs Order/User models and
 * would create a circular import back through them) — injecting this
 * @Global() service instead avoids that entirely. Before the gateway's
 * afterInit() runs, `server` is undefined and emits are silently no-ops
 * (e.g. during app bootstrap or in tests that don't stand up sockets).
 */
/**
 * ⚠ DELIBERATELY UNCHANGED by spec 012 Story 9 (T087).
 *
 * Cross-instance delivery is provided by attaching `@socket.io/redis-adapter`
 * to the single `Server` in `TrackingGateway.afterInit` — which sits UPSTREAM
 * of this service. Every outbound emission in the codebase already funnels
 * through `emitToOrderRoom`/`emitToUser`, so one attachment covers all five
 * event types and both addressing modes, and none of the six calling services
 * needs to know that events now cross instances.
 *
 * So: do not add fan-out logic, a publish/subscribe path, or an instance id to
 * this file. Anything of that shape here would be a second mechanism running
 * alongside the adapter, and the failure it produces — events delivered twice
 * to some clients and once to others — is far harder to see than the one it
 * would be trying to fix.
 */
@Injectable()
export class RealtimeGatewayService {
  private readonly logger = new Logger(RealtimeGatewayService.name);
  private server?: Server;

  setServer(server: Server): void {
    this.server = server;
  }

  emitToOrderRoom(orderId: string, event: string, payload: unknown): void {
    this.server?.to(`order:${orderId}`).emit(event, payload);
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  /**
   * feature 013 US2 (realtime-contract §3): drop every socket in a user's
   * room — used when `AuthService.login` displaces a prior session, so a
   * displaced device's connection ends rather than being left open, retrying
   * and holding a socket slot with every frame refused (FR-017).
   *
   * `disconnectSockets` is a room operation, so it reaches sockets on any
   * instance through the Redis adapter — the same mechanism `emitToUser`
   * relies on. It is NOT the guarantee: a disconnect can be lost, and the
   * adapter is a dependency spec 012 Q7 lets degrade — `TrackingGateway`'s
   * per-frame `sgen` check is what actually stops a displaced device
   * writing. So a failure here is logged and swallowed: it must never break
   * the sign-in that triggered it.
   */
  disconnectUser(userId: string): void {
    try {
      this.server?.in(`user:${userId}`).disconnectSockets(true);
    } catch (err) {
      this.logger.error({ err, userId }, 'Failed to disconnect displaced sockets — degraded');
    }
  }
}
