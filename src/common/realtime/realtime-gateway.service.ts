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
}
