import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { Order, OrderDocument } from './schemas/order.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { CreateOrderDto } from './dto/create-order.dto';
import { CompaniesService } from '../companies/companies.service';
import { UsersService } from '../users/users.service';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { User, UserDocument } from '../users/schemas/user.schema';
import { OrderStateService, TransitionActor } from './services/order-state.service';
import { OtpService } from './services/otp.service';
import { PaymentTimeoutQueueService } from '../payments/queues/payment-timeout-queue.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly companiesService: CompaniesService,
    private readonly usersService: UsersService,
    private readonly orderStateService: OrderStateService,
    private readonly otpService: OtpService,
    private readonly paymentTimeoutQueue: PaymentTimeoutQueueService,
  ) {}

  async create(clientUser: AuthenticatedUser, dto: CreateOrderDto): Promise<OrderDocument> {
    if (!clientUser.companyId) {
      throw new ForbiddenException('Client must belong to a company');
    }

    const basePrice = await this.companiesService.getBasePrice(clientUser.companyId, dto.fuelType);
    if (basePrice === undefined) {
      throw new BadRequestException(
        `No base price configured for fuel type ${dto.fuelType} — contact your company admin`,
      );
    }

    const client = await this.usersService.findById(clientUser.userId);
    const deliveryLocation = dto.deliveryLocation
      ? {
          type: 'Point',
          coordinates: [dto.deliveryLocation.longitude, dto.deliveryLocation.latitude],
        }
      : client.stationLocation;
    if (!deliveryLocation) {
      throw new BadRequestException(
        'No delivery location provided and client has no station location on file',
      );
    }

    const estimatedPrice = Number((basePrice * dto.quantityLiters).toFixed(2));

    return this.orderModel.create({
      companyId: new Types.ObjectId(clientUser.companyId),
      clientId: new Types.ObjectId(clientUser.userId),
      fuelType: dto.fuelType,
      quantityLiters: dto.quantityLiters,
      deliveryLocation,
      status: OrderStatus.PENDING_APPROVAL,
      estimatedPrice,
    });
  }

  async findById(id: string): Promise<OrderDocument> {
    const order = await this.orderModel.findById(id).exec();
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  /** Enforces per-role visibility on top of the tenant plugin's companyId scoping. */
  findForUser(user: AuthenticatedUser, filter: { status?: OrderStatus }): Promise<OrderDocument[]> {
    const query: Record<string, unknown> = {};
    if (filter.status) {
      query.status = filter.status;
    }
    if (user.role === UserRole.CLIENT) {
      query.clientId = user.userId;
    } else if (user.role === UserRole.DRIVER) {
      query.driverId = user.userId;
    }
    return this.orderModel.find(query).sort({ createdAt: -1 }).exec();
  }

  async findOneForUser(user: AuthenticatedUser, id: string): Promise<OrderDocument> {
    const order = await this.findById(id);
    const isOwner =
      (user.role === UserRole.CLIENT && String(order.clientId) === user.userId) ||
      (user.role === UserRole.DRIVER && String(order.driverId) === user.userId) ||
      user.role === UserRole.COMPANY_ADMIN ||
      user.role === UserRole.SUPER_ADMIN;
    if (!isOwner) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  private async releaseDriverIfAssigned(
    order: OrderDocument,
    session: import('mongoose').ClientSession,
  ): Promise<void> {
    if (order.driverId) {
      await this.userModel
        .updateOne(
          { _id: order.driverId, activeOrderId: order._id },
          { $set: { isAvailable: true }, $unset: { activeOrderId: '' } },
          { session },
        )
        .exec();
    }
  }

  async cancel(
    order: OrderDocument,
    from: OrderStatus,
    actor: TransitionActor,
    reason?: string,
  ): Promise<OrderDocument> {
    const session = await this.connection.startSession();
    try {
      let updated!: OrderDocument;
      await session.withTransaction(async () => {
        await this.releaseDriverIfAssigned(order, session);
        updated = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          from,
          OrderStatus.CANCELLED,
          actor,
          {
            session,
            extraSet: {
              cancelledBy: new Types.ObjectId(actor.actorId),
              cancellationReason: reason,
            },
          },
        );
      });
      if (from === OrderStatus.ASSIGNED_TO_DRIVER || from === OrderStatus.PENDING_PAYMENT) {
        await this.paymentTimeoutQueue.cancel(String(order._id));
      }
      return updated;
    } finally {
      await session.endSession();
    }
  }

  async completeDelivery(order: OrderDocument, actor: TransitionActor): Promise<OrderDocument> {
    const session = await this.connection.startSession();
    try {
      let updated!: OrderDocument;
      await session.withTransaction(async () => {
        await this.releaseDriverIfAssigned(order, session);
        updated = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          OrderStatus.UNLOADING,
          OrderStatus.DELIVERED,
          actor,
          { session },
        );
      });
      return updated;
    } finally {
      await session.endSession();
    }
  }

  async forceComplete(
    order: OrderDocument,
    from: OrderStatus,
    actor: TransitionActor,
    reason: string,
  ): Promise<OrderDocument> {
    const session = await this.connection.startSession();
    try {
      let updated!: OrderDocument;
      await session.withTransaction(async () => {
        await this.releaseDriverIfAssigned(order, session);
        updated = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          from,
          OrderStatus.DELIVERED,
          actor,
          { session, manualOverride: true, overrideReason: reason },
        );
        await this.otpService.invalidateActive(String(order._id), session);
      });
      if (from === OrderStatus.ASSIGNED_TO_DRIVER || from === OrderStatus.PENDING_PAYMENT) {
        await this.paymentTimeoutQueue.cancel(String(order._id));
      }
      this.logger.warn(
        `Manual override (force-complete): order=${order._id} from=${from} actor=${actor.actorId} reason="${reason}"`,
      );
      return updated;
    } finally {
      await session.endSession();
    }
  }
}
