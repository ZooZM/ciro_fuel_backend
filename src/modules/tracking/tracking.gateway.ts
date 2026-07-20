import { Logger, UseGuards } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { RealtimeGatewayService } from '../../common/realtime/realtime-gateway.service';
import { PresenceService } from './presence/presence.service';
import { authenticateSocket, WsJwtGuard } from '../../common/guards/ws-jwt.guard';
import { haversineDistanceMeters } from '../../common/utils/geo.util';

interface AuthedSocket extends Socket {
  data: { user: AuthenticatedUser };
}

@WebSocketGateway({ namespace: 'tracking', cors: { origin: '*' } })
export class TrackingGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(TrackingGateway.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly realtimeGateway: RealtimeGatewayService,
    private readonly presenceService: PresenceService,
  ) {}

  afterInit(server: Server): void {
    this.realtimeGateway.setServer(server);
    server.use(async (socket: Socket, next: (err?: Error) => void) => {
      try {
        const user = await authenticateSocket(
          socket,
          this.jwtService,
          this.config,
          this.usersService,
        );
        (socket as AuthedSocket).data.user = user;
        next();
      } catch {
        next(new Error('UNAUTHORIZED'));
      }
    });
  }

  async handleConnection(client: AuthedSocket): Promise<void> {
    // Every socket joins its own user room so notification:new / order:otp
    // can address it directly regardless of which order rooms it watches.
    await client.join(`user:${client.data.user.userId}`);
    if (client.data.user.role === UserRole.DRIVER) {
      await this.presenceService.touch(client.data.user.userId);
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('order:watch')
  async watch(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() data: { orderId: string },
  ): Promise<{ ok: boolean; error?: string }> {
    return this.tenantContext.run(this.toContext(client), async () => {
      if (client.data.user.role === UserRole.DRIVER) {
        return { ok: false, error: 'FORBIDDEN_ROLE' };
      }
      const order = await this.orderModel.findById(data.orderId).exec();
      if (!order) {
        return { ok: false, error: 'NOT_FOUND' };
      }
      if (
        client.data.user.role === UserRole.CLIENT &&
        String(order.clientId) !== client.data.user.userId
      ) {
        return { ok: false, error: 'NOT_FOUND' };
      }
      if (order.status !== OrderStatus.IN_TRANSIT && order.status !== OrderStatus.UNLOADING) {
        return { ok: false, error: 'NOT_TRACKABLE' };
      }
      await client.join(`order:${data.orderId}`);
      return { ok: true };
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('order:unwatch')
  async unwatch(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() data: { orderId: string },
  ): Promise<{ ok: boolean }> {
    await client.leave(`order:${data.orderId}`);
    return { ok: true };
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('location:update')
  async locationUpdate(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() data: { lat: number; lng: number; recordedAt: string },
  ): Promise<{ ok: boolean; accepted?: boolean; reason?: string; error?: string }> {
    return this.tenantContext.run(this.toContext(client), async () => {
      if (client.data.user.role !== UserRole.DRIVER) {
        return { ok: false, error: 'FORBIDDEN_ROLE' };
      }

      // Presence updates regardless of whether the point itself gets accepted.
      await this.presenceService.touch(client.data.user.userId);

      const driver = await this.userModel.findById(client.data.user.userId).exec();
      if (!driver?.activeOrderId) {
        return { ok: false, error: 'NO_ACTIVE_ORDER' };
      }

      const displacementThreshold =
        this.config.get<number>('tracking.displacementThresholdMeters') ?? 50;
      const heartbeatMs = (this.config.get<number>('tracking.heartbeatMinutes') ?? 3) * 60_000;
      const abuseCeilingMs = 5_000;

      const now = new Date();
      const lastAt = driver.locationUpdatedAt?.getTime() ?? 0;
      const elapsedMs = now.getTime() - lastAt;

      if (elapsedMs < abuseCeilingMs) {
        return { ok: true, accepted: false, reason: 'BELOW_THRESHOLD' };
      }

      const distance = driver.location
        ? haversineDistanceMeters(driver.location.coordinates, [data.lng, data.lat])
        : Infinity;

      const accepted = distance > displacementThreshold || elapsedMs >= heartbeatMs;
      if (!accepted) {
        return { ok: true, accepted: false, reason: 'BELOW_THRESHOLD' };
      }

      await this.userModel
        .updateOne(
          { _id: driver._id },
          {
            $set: {
              location: { type: 'Point', coordinates: [data.lng, data.lat] },
              locationUpdatedAt: now,
            },
          },
        )
        .exec();

      const orderId = String(driver.activeOrderId);
      this.realtimeGateway.emitToOrderRoom(orderId, 'order:location', {
        orderId,
        lat: data.lat,
        lng: data.lng,
        recordedAt: data.recordedAt,
        receivedAt: now.toISOString(),
      });

      return { ok: true, accepted: true };
    });
  }

  private toContext(client: AuthedSocket) {
    return {
      userId: client.data.user.userId,
      role: client.data.user.role,
      companyId: client.data.user.companyId,
    };
  }
}
