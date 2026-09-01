import { Logger, OnApplicationShutdown, UseGuards } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
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

// CORS is NOT declared here. It was `{ origin: '*' }` — a hardcoded
// wildcard that applied in every environment including production, while
// the REST API had no CORS in production at all. The policy now comes from
// `AppIoAdapter`, which reads the same allowlist the REST side uses, so the
// two cannot drift (spec 012 Story 3, FR-014/FR-016). A decorator cannot
// read ConfigService: its options are evaluated before DI exists.
@WebSocketGateway({ namespace: 'tracking' })
export class TrackingGateway implements OnGatewayConnection, OnApplicationShutdown {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(TrackingGateway.name);
  private redisAdapterClients: Redis[] = [];

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
    // Order matters, and so does staying SYNCHRONOUS. Nest does not await
    // `afterInit`, so anything moved behind an `await` here happens after the
    // gateway is considered initialised — `setServer` in particular must run
    // now, or emissions in that window are silent no-ops.
    this.realtimeGateway.setServer(server);
    this.attachRedisAdapter(server);
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
      if (!driver) {
        return { ok: false, error: 'FORBIDDEN_ROLE' };
      }

      // A driver's position is recorded whether or not they are carrying an
      // order. It used to be rejected with NO_ACTIVE_ORDER, which deadlocked
      // dispatch: `DispatchService.findCandidates` runs `$geoNear`, and
      // `$geoNear` silently omits any document with no `location` — so a
      // driver could not be assigned their first order until they had a
      // location, and could not record a location until they had been
      // assigned an order. Whereabouts is precisely what makes a driver
      // dispatchable, so gating it on already having work was backwards.
      //
      // Only the broadcast below is order-scoped; there is no room to emit
      // into when the driver is idle.

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

      // spec 011 FR-003/FR-017: movement bookkeeping, alongside the position
      // write this handler already performs. Displacement is measured from
      // `lastMovedLocation` — the last position we called *movement* — and
      // deliberately NOT from `driver.location`, which every accepted fix
      // above updates. Measuring from `location` would let a parked truck
      // creep past the threshold in repeated sub-threshold steps and read as
      // moving, so a genuinely stalled delivery would never be detected.
      //
      // A driver who has never moved has no baseline, so their first
      // accepted fix establishes one (Infinity forces the branch).
      const movementThreshold = this.config.get<number>('stopDetection.movementMeters') ?? 50;
      const movedDistance = driver.lastMovedLocation
        ? haversineDistanceMeters(driver.lastMovedLocation.coordinates, [data.lng, data.lat])
        : Infinity;
      const hasMoved = movedDistance > movementThreshold;

      await this.userModel
        .updateOne(
          { _id: driver._id },
          {
            $set: {
              location: { type: 'Point', coordinates: [data.lng, data.lat] },
              locationUpdatedAt: now,
              // Only on genuine movement — a heartbeat from a parked truck
              // advances `locationUpdatedAt`/`lastSeenAt` above but must
              // leave these untouched, which is what the stop sweep reads.
              ...(hasMoved
                ? {
                    lastMovedAt: now,
                    lastMovedLocation: { type: 'Point', coordinates: [data.lng, data.lat] },
                  }
                : {}),
            },
          },
        )
        .exec();

      if (driver.activeOrderId) {
        const orderId = String(driver.activeOrderId);
        this.realtimeGateway.emitToOrderRoom(orderId, 'order:location', {
          orderId,
          lat: data.lat,
          lng: data.lng,
          recordedAt: data.recordedAt,
          receivedAt: now.toISOString(),
        });
      }

      return { ok: true, accepted: true };
    });
  }

  /**
   * Cross-instance realtime delivery — spec 012 FR-059/FR-060.
   *
   * **This is the entire realtime fix, and it is one attachment.** Every
   * outbound emission in the codebase funnels through `RealtimeGatewayService`
   * (`emitToOrderRoom`/`emitToUser`), and this gateway makes no direct emit at
   * all — so attaching the adapter to the single `Server` covers all five event
   * types and both addressing modes without touching any of the six calling
   * services. `RealtimeGatewayService` itself is deliberately unchanged: the
   * adapter sits upstream of it.
   *
   * Without it, a client connected to instance A never receives an event
   * emitted by instance B. A customer watching a delivery sees the truck stop
   * moving, and a driver never receives the status change — with two replicas
   * that is roughly half of all events, silently.
   *
   * **Two connections, not one, and not the shared `REDIS_CLIENT`.** The
   * adapter's subscriber enters Redis subscriber mode, in which the connection
   * can issue nothing but (un)subscribe commands. Reusing the application's
   * client would break every cache read, throttler counter and scheduler lease
   * on the instance the moment the adapter attached.
   *
   * **This is the one degradation that CANNOT fail open** (Q7). If the adapter
   * is broken, events still reach the emitting instance's own clients, so from
   * that instance's vantage point delivery is indistinguishable from success —
   * no error, no exception, no failed request. It is closed by an alert
   * (operations-contract §6) and by the readiness body reporting Redis, not by
   * anything this code can detect locally.
   */
  private attachRedisAdapter(namespace: Server): void {
    // ⚠ `afterInit` hands a NAMESPACE, not the root Server — this gateway is
    // declared `@WebSocketGateway({ namespace: 'tracking' })`, and Nest passes
    // the namespace for a namespaced gateway. `Namespace.adapter` is a
    // PROPERTY (an adapter instance), not a method, so calling
    // `namespace.adapter(createAdapter(...))` throws
    // "server.adapter is not a function". The root server is reachable as
    // `namespace.server`, and `Server.adapter()` re-initialises every existing
    // namespace, so attaching there covers `/tracking` too.
    //
    // This was found by `multi-instance.e2e-spec.ts` and by nothing else: the
    // throw lands in the catch below, gets logged, and every single-instance
    // test still passes. It is precisely the shape of failure this story is
    // about — a realtime defect that is invisible from one instance.
    const root = (namespace as unknown as { server?: Server }).server ?? namespace;

    try {
      // NOT the shared `REDIS_CLIENT`, and two connections rather than one: the
      // adapter's subscriber enters Redis subscriber mode, in which the
      // connection can issue nothing but (un)subscribe commands. Reusing the
      // application's client would break every cache read, throttler counter
      // and scheduler lease on this instance the moment the adapter attached.
      const url = this.config.get<string>('redisUrl')!;
      const pubClient = new Redis(url, { maxRetriesPerRequest: null });
      const subClient = pubClient.duplicate();

      // ioredis queues commands until the connection is up, so the adapter can
      // be attached synchronously and a slow Redis simply delays delivery
      // rather than leaving a window in which the adapter is not attached at
      // all. An unhandled 'error' event on either client would crash the
      // process, so both are handled — a connection error must degrade
      // realtime, never take the instance down (Q7).
      pubClient.on('error', (err) =>
        this.logger.error({ err }, 'Realtime adapter publisher error'),
      );
      subClient.on('error', (err) =>
        this.logger.error({ err }, 'Realtime adapter subscriber error'),
      );

      root.adapter(createAdapter(pubClient, subClient));
      this.redisAdapterClients = [pubClient, subClient];
      this.logger.log('Realtime Redis adapter attached — events span instances');
    } catch (err) {
      // Deliberately NOT fatal. Redis is not a disqualifying dependency (Q7),
      // and refusing to start here would take every instance out of rotation at
      // once over a dependency the platform is designed to survive. Degraded
      // means single-instance delivery — what the platform did before this
      // feature — recorded loudly, because nothing else will surface it.
      this.logger.error(
        { err },
        'Realtime Redis adapter FAILED to attach — events will not cross instances',
      );
    }
  }

  /**
   * Closed on shutdown so the two adapter connections do not outlive the app
   * (FR-011).
   *
   * `onApplicationShutdown`, NOT `onModuleDestroy`, and the difference is not
   * cosmetic. Nest's `close()` runs `callDestroyHook()` BEFORE `dispose()`, so
   * an `onModuleDestroy` here would quit these clients while the Socket.io
   * server — and the adapter holding live subscriptions on them — is still
   * running. ioredis then rejects those pending subscriptions with
   * "Connection is closed", as unhandled rejections during teardown. This phase
   * runs after `dispose()`, when the adapter is finished with them.
   */
  async onApplicationShutdown(): Promise<void> {
    const clients = this.redisAdapterClients;
    this.redisAdapterClients = [];

    // Let the adapter's own teardown settle first. `dispose()` disconnects every
    // socket, and each one leaving its rooms makes the adapter issue
    // `unsubscribe` commands on the subscriber. Closing the connection while
    // those are in flight makes ioredis reject them with "Connection is closed"
    // — and the adapter does not catch its own, so they surface as unhandled
    // rejections during shutdown. One turn of the event loop is enough for
    // commands that have already been written.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await Promise.all(
      clients.map(async (client) => {
        // Late errors on a connection that is deliberately going away are not
        // worth recording, and an unhandled 'error' event would crash the
        // process we are trying to exit cleanly.
        client.removeAllListeners('error');
        client.on('error', () => undefined);
        await client.quit().catch(() => undefined);
      }),
    );
  }

  private toContext(client: AuthedSocket) {
    return {
      userId: client.data.user.userId,
      role: client.data.user.role,
      companyId: client.data.user.companyId,
    };
  }
}
