import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { OrderStateService } from './services/order-state.service';
import { OtpService } from './services/otp.service';
import { DispatchService } from '../dispatch/services/dispatch.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ApproveOrderDto } from './dto/approve-order.dto';
import { RejectOrderDto } from './dto/reject-order.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ForceCompleteOrderDto } from './dto/force-complete-order.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { OtpPurpose } from './schemas/order.schema';
import { NotificationType } from '../../common/enums/notification-type.enum';

@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly orderStateService: OrderStateService,
    private readonly otpService: OtpService,
    private readonly dispatchService: DispatchService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Roles(UserRole.CLIENT)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(user, dto);
  }

  @Get()
  findMine(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: OrderStatus) {
    return this.ordersService.findForUser(user, { status });
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    return this.ordersService.findOneForUser(user, id);
  }

  @Roles(UserRole.COMPANY_ADMIN)
  @Patch(':id/approve')
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: ApproveOrderDto,
  ) {
    const order = await this.ordersService.findById(id);
    const finalPrice = dto.finalPrice ?? order.estimatedPrice;

    const updated = await this.orderStateService.transition(
      id,
      OrderStatus.PENDING_APPROVAL,
      OrderStatus.APPROVED,
      { actorId: user.userId, actorRole: user.role },
      { extraSet: { finalPrice, approvedBy: user.userId } },
    );

    await this.notificationsService.notify({
      companyId: updated.companyId,
      recipientUserId: updated.clientId,
      type: NotificationType.ORDER_APPROVED_FINAL_PRICE,
      orderId: updated._id as never,
      payload: { finalPrice },
    });

    await this.dispatchService.assignDriver(id);
    return this.ordersService.findById(id);
  }

  @Roles(UserRole.COMPANY_ADMIN)
  @Patch(':id/reject')
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: RejectOrderDto,
  ) {
    return this.orderStateService.transition(
      id,
      OrderStatus.PENDING_APPROVAL,
      OrderStatus.REJECTED,
      { actorId: user.userId, actorRole: user.role },
      { extraSet: { rejectedBy: user.userId, rejectionReason: dto.reason } },
    );
  }

  @Patch(':id/cancel')
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    const order = await this.ordersService.findOneForUser(user, id);
    const isClient = user.role === UserRole.CLIENT && String(order.clientId) === user.userId;
    const isAdmin = user.role === UserRole.COMPANY_ADMIN;

    if (!isClient && !isAdmin) {
      throw new ForbiddenException('Not permitted to cancel this order');
    }

    let from: OrderStatus;
    if (isClient) {
      // Clients may cancel pre-assignment, or decline the final price while
      // awaiting payment (FR-009); anything else is admin-only.
      if (
        order.status !== OrderStatus.PENDING_APPROVAL &&
        order.status !== OrderStatus.APPROVED &&
        order.status !== OrderStatus.PENDING_PAYMENT
      ) {
        throw new ForbiddenException('Clients may not cancel an order at this stage');
      }
      from = order.status;
    } else {
      if (
        order.status !== OrderStatus.PENDING_APPROVAL &&
        order.status !== OrderStatus.APPROVED &&
        order.status !== OrderStatus.ASSIGNED_TO_DRIVER &&
        order.status !== OrderStatus.PENDING_PAYMENT
      ) {
        throw new ForbiddenException('This order can no longer be cancelled');
      }
      from = order.status;
    }

    return this.ordersService.cancel(
      order,
      from,
      { actorId: user.userId, actorRole: user.role },
      dto.reason,
    );
  }

  @Roles(UserRole.COMPANY_ADMIN, UserRole.CLIENT)
  @Post(':id/redispatch')
  async redispatch(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const order = await this.ordersService.findOneForUser(user, id);
    if (order.status !== OrderStatus.APPROVED) {
      throw new ConflictException('Order must be APPROVED (post payment-timeout) to redispatch');
    }
    if (user.role === UserRole.CLIENT && (order.paymentTimeoutCount ?? 0) >= 2) {
      throw new ForbiddenException(
        'Two consecutive payment timeouts occurred — only the Company Admin may redispatch now',
      );
    }
    return this.dispatchService.assignDriver(id);
  }

  @Roles(UserRole.DRIVER)
  @Post(':id/arrive')
  async arrive(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.IN_TRANSIT);
    await this.otpService.issue(String(order._id), OtpPurpose.ARRIVAL);
    await this.notificationsService.notify({
      companyId: order.companyId,
      recipientUserId: order.clientId,
      type: NotificationType.OTP_ISSUED,
      orderId: order._id as never,
      payload: { purpose: OtpPurpose.ARRIVAL },
    });
    return { status: 'ARRIVAL_OTP_ISSUED' };
  }

  @Roles(UserRole.CLIENT)
  @Get(':id/otp/current')
  async currentOtp(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    const order = await this.ordersService.findOneForUser(user, id);
    if (String(order.clientId) !== user.userId) {
      throw new NotFoundException('Order not found');
    }
    const purpose =
      order.status === OrderStatus.UNLOADING ? OtpPurpose.DELIVERY : OtpPurpose.ARRIVAL;
    const current = await this.otpService.peekCurrent(String(order._id), purpose);
    if (!current) {
      throw new NotFoundException('No active OTP for this order');
    }
    return current;
  }

  @Roles(UserRole.DRIVER)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @Post(':id/verify-arrival')
  async verifyArrival(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: VerifyOtpDto,
  ) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.IN_TRANSIT);
    await this.otpService.verify(String(order._id), OtpPurpose.ARRIVAL, dto.otp);
    return this.orderStateService.transition(id, OrderStatus.IN_TRANSIT, OrderStatus.UNLOADING, {
      actorId: user.userId,
      actorRole: user.role,
    });
  }

  @Roles(UserRole.DRIVER)
  @Post(':id/request-delivery-otp')
  async requestDeliveryOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.UNLOADING);
    await this.otpService.issue(String(order._id), OtpPurpose.DELIVERY);
    await this.notificationsService.notify({
      companyId: order.companyId,
      recipientUserId: order.clientId,
      type: NotificationType.OTP_ISSUED,
      orderId: order._id as never,
      payload: { purpose: OtpPurpose.DELIVERY },
    });
    return { status: 'DELIVERY_OTP_ISSUED' };
  }

  @Roles(UserRole.DRIVER)
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @Post(':id/verify-delivery')
  async verifyDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: VerifyOtpDto,
  ) {
    const order = await this.assertDriverAssigned(user, id, OrderStatus.UNLOADING);
    await this.otpService.verify(String(order._id), OtpPurpose.DELIVERY, dto.otp);
    return this.ordersService.completeDelivery(order, {
      actorId: user.userId,
      actorRole: user.role,
    });
  }

  @Roles(UserRole.COMPANY_ADMIN)
  @Patch(':id/force-complete')
  async forceComplete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: ForceCompleteOrderDto,
  ) {
    const order = await this.ordersService.findById(id);
    if (order.status !== OrderStatus.IN_TRANSIT && order.status !== OrderStatus.UNLOADING) {
      throw new ConflictException('Force-complete only allowed from IN_TRANSIT or UNLOADING');
    }
    return this.ordersService.forceComplete(
      order,
      order.status,
      { actorId: user.userId, actorRole: user.role },
      dto.reason,
    );
  }

  private async assertDriverAssigned(
    user: AuthenticatedUser,
    id: string,
    expectedStatus: OrderStatus,
  ) {
    const order = await this.ordersService.findById(id);
    if (String(order.driverId) !== user.userId) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== expectedStatus) {
      throw new BadRequestException(`Order is not ${expectedStatus}`);
    }
    return order;
  }
}
