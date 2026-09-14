import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentEvent,
  PaymentEventDocument,
  PaymentEventOutcome,
  PaymentGateway,
} from './schemas/payment-event.schema';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { CursorSortField } from '../../common/pagination/cursor.util';

// Matches the { clientId, createdAt, _id } index the schema already carries
// for this (spec 005 FR-023/research R3).
const PAYMENT_SORT_KEYS: CursorSortField[] = [
  { field: 'createdAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { OrderStateService } from '../orders/services/order-state.service';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { PaymentTimeoutQueueService } from './queues/payment-timeout-queue.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../../common/enums/notification-type.enum';
import { SYSTEM_ACTOR } from '../../common/constants/system-actor';
import { UserRole } from '../../common/enums/user-role.enum';
import { InvoicesService } from '../invoices/invoices.service';
import { isDuplicateKeyError } from '../../common/utils/mongo-error.util';

export interface WebhookResult {
  received: true;
  duplicate?: boolean;
  accepted?: boolean;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(PaymentEvent.name) private readonly paymentEventModel: Model<PaymentEventDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly orderStateService: OrderStateService,
    private readonly paymentTimeoutQueue: PaymentTimeoutQueueService,
    private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService,
    private readonly invoicesService: InvoicesService,
  ) {}

  /** A CLIENT's own confirmed payments (spec 005 FR-023), paginated,
   * newest first. `rawPayload` is excluded at the query level, not
   * stripped after — it can carry gateway card metadata (Principle II) —
   * and only CONFIRMED events are shown: a failed/invalid webhook attempt
   * is reconciliation noise, not something the client ever paid. */
  findForClient(
    clientId: string,
    cursor: string | undefined,
  ): Promise<PaginatedResponse<PaymentEventDocument>> {
    return paginate(
      this.paymentEventModel,
      { clientId: new Types.ObjectId(clientId), outcome: PaymentEventOutcome.CONFIRMED },
      PAYMENT_SORT_KEYS,
      cursor,
      undefined,
      { rawPayload: 0 },
    );
  }

  verifySignature(
    gateway: PaymentGateway,
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): boolean {
    if (!signatureHeader) return false;
    const secret =
      gateway === PaymentGateway.SADAD
        ? this.config.get<string>('payment.sadadSecret')
        : this.config.get<string>('payment.madaSecret');
    if (!secret) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(signatureHeader, 'hex');
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  async handleWebhook(
    gateway: PaymentGateway,
    dto: PaymentWebhookDto,
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): Promise<WebhookResult> {
    if (!this.verifySignature(gateway, rawBody, signatureHeader)) {
      await this.recordEvent(gateway, dto, PaymentEventOutcome.INVALID_SIGNATURE, undefined);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const order = await this.orderModel.findById(dto.orderId).exec();
    if (!order) {
      throw new BadRequestException(`Unknown orderId ${dto.orderId}`);
    }

    // Exactly-once via the unique index on gatewayTransactionId (FR-015, R5).
    let eventDoc: PaymentEventDocument;
    try {
      eventDoc = await this.paymentEventModel.create({
        gatewayTransactionId: dto.transactionId,
        gateway,
        orderId: order._id,
        companyId: order.fuelCompanyId,
        clientId: order.clientId,
        amount: dto.amount,
        currency: dto.currency,
        outcome: PaymentEventOutcome.CONFIRMED, // tentative; corrected below if not applicable
        rawPayload: dto as unknown as Record<string, unknown>,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        this.logger.warn(
          `Payment webhook outcome=DUPLICATE order=${dto.orderId} gatewayTxn=${dto.transactionId}`,
        );
        return { received: true, duplicate: true };
      }
      throw err;
    }

    if (dto.status !== 'PAID') {
      await this.markOutcome(eventDoc, PaymentEventOutcome.OUT_OF_SEQUENCE);
      return { received: true, accepted: false };
    }

    if (dto.amount !== order.finalPrice || dto.currency !== 'SAR') {
      await this.markOutcome(eventDoc, PaymentEventOutcome.AMOUNT_MISMATCH);
      await this.notifyAdmins(order, NotificationType.PAYMENT_RECONCILIATION_REQUIRED);
      return { received: true, accepted: false };
    }

    const session = await this.connection.startSession();
    let confirmedOrder: OrderDocument | undefined;
    try {
      await session.withTransaction(async () => {
        // Settling the invoice and moving the order on happen together — if
        // either fails the whole transaction rolls back, so a webhook can never
        // leave the invoice settled with the order still gating payment, or
        // vice versa.
        //
        // The destination is ROUTED_TO_TRANSPORT, not APPROVED. Under the
        // amended flow the order was ALREADY routed before the station owner
        // was asked to pay — routing is what priced the haul and produced the
        // total they are settling — so settlement resumes the transporter it
        // already has rather than sending it back to be routed.
        await this.invoicesService.settleInvoiceForOrder(order._id, dto.transactionId, session);
        confirmedOrder = await this.orderStateService.transition(
          order._id as Types.ObjectId,
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.ROUTED_TO_TRANSPORT,
          SYSTEM_ACTOR,
          {
            session,
            extraSet: { paymentConfirmationId: eventDoc._id },
            extraUnset: ['paymentDeadline'],
          },
        );
      });

      if (confirmedOrder) {
        await this.paymentTimeoutQueue.cancel(String(order._id));
        // No routing call here any more — the order was routed before payment
        // was ever asked for, which is what removed this service's dependency
        // on `RoutingService` (and with it the DispatchModule -> PaymentsModule
        // cycle that dependency used to force).
        await this.notificationsService.notify({
          companyId: order.fuelCompanyId,
          recipientUserId: order.clientId,
          type: NotificationType.ORDER_STATUS_CHANGED,
          orderId: order._id as Types.ObjectId,
          payload: { status: confirmedOrder.status },
        });
        this.logger.log(
          `Payment webhook outcome=CONFIRMED order=${order._id} gatewayTxn=${dto.transactionId}`,
        );
        return { received: true, accepted: true };
      }
    } catch {
      // Order was no longer PENDING_PAYMENT (e.g. timeout reversion raced this
      // webhook, or it was cancelled) — treat as out-of-sequence, not an error.
      await this.markOutcome(eventDoc, PaymentEventOutcome.OUT_OF_SEQUENCE);
      await this.notifyAdmins(order, NotificationType.PAYMENT_RECONCILIATION_REQUIRED);
      return { received: true, accepted: false };
    } finally {
      await session.endSession();
    }

    return { received: true, accepted: false };
  }

  private async markOutcome(
    event: PaymentEventDocument,
    outcome: PaymentEventOutcome,
  ): Promise<void> {
    await this.paymentEventModel.updateOne({ _id: event._id }, { $set: { outcome } }).exec();
    this.logger.warn(
      `Payment webhook outcome=${outcome} order=${event.orderId} gatewayTxn=${event.gatewayTransactionId}`,
    );
  }

  private async recordEvent(
    gateway: PaymentGateway,
    dto: PaymentWebhookDto,
    outcome: PaymentEventOutcome,
    companyId: Types.ObjectId | undefined,
  ): Promise<void> {
    try {
      await this.paymentEventModel.create({
        gatewayTransactionId: dto.transactionId ?? `unknown-${Date.now()}`,
        gateway,
        orderId: dto.orderId ? new Types.ObjectId(dto.orderId) : new Types.ObjectId(),
        companyId: companyId ?? new Types.ObjectId(),
        amount: dto.amount ?? 0,
        currency: dto.currency ?? 'SAR',
        outcome,
        rawPayload: dto as unknown as Record<string, unknown>,
      });
    } catch (err) {
      this.logger.error(`Failed to record ${outcome} payment event`, err as Error);
    }
  }

  private async notifyAdmins(order: OrderDocument, type: NotificationType): Promise<void> {
    const admins = await this.userModel
      .find({ companyId: order.fuelCompanyId, role: UserRole.FUEL_COMPANY_ADMIN, isActive: true })
      .exec();
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          companyId: order.fuelCompanyId,
          recipientUserId: admin._id,
          type,
          orderId: order._id as Types.ObjectId,
        }),
      ),
    );
  }
}
