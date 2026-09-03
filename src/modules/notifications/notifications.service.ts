import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification, NotificationDocument } from './schemas/notification.schema';
import { NotificationType } from '../../common/enums/notification-type.enum';
import { RealtimeGatewayService } from '../../common/realtime/realtime-gateway.service';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { CursorSortField } from '../../common/pagination/cursor.util';

const NOTIFICATION_SORT_KEYS: CursorSortField[] = [
  { field: 'createdAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    private readonly realtimeGateway: RealtimeGatewayService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Explicitly takes companyId rather than relying on the tenant plugin,
   * because most callers (BullMQ processors, webhook handlers, dispatch
   * service) run outside an HTTP request's AsyncLocalStorage context — and,
   * since spec 004, some callers that DO run inside one (e.g. a
   * FUEL_COMPANY_ADMIN approving an order) still need to notify a
   * recipient in a DIFFERENT tenant (that order's Transportation Company).
   * `runUnscoped` makes the explicit `companyId` here authoritative either
   * way, rather than the tenant plugin silently overwriting it with the
   * acting user's own company on this create.
   */
  async notify(params: {
    companyId: string | Types.ObjectId;
    recipientUserId: string | Types.ObjectId;
    type: NotificationType;
    orderId?: string | Types.ObjectId;
    payload?: Record<string, unknown>;
  }): Promise<NotificationDocument> {
    const notification = await this.tenantContext.runUnscoped(() =>
      this.notificationModel.create({
        companyId: params.companyId,
        recipientUserId: params.recipientUserId,
        type: params.type,
        orderId: params.orderId,
        payload: params.payload ?? {},
      }),
    );
    this.realtimeGateway.emitToUser(String(params.recipientUserId), 'notification:new', {
      id: String(notification._id),
      type: notification.type,
      orderId: params.orderId ? String(params.orderId) : undefined,
      payload: notification.payload,
    });
    return notification;
  }

  /**
   * Paginated (spec 005 FR-031); `unreadCount` is a live `countDocuments`
   * over the caller's *whole* set — never scoped to the current page, and
   * never a stored counter that could drift from the notifications
   * themselves (T087).
   */
  /**
   * feature 013 US3: `runUnscoped`, keyed strictly on `recipientUserId` — the
   * same discipline `notify` uses for the write. A notification's `companyId`
   * is the *order's* fuel company (every `notify` call site), which for a
   * DRIVER recipient is a different tenant from the driver's own `companyId`
   * (their transport company). With the ambient tenant filter on, a driver is
   * scoped out of every notification addressed to them — `ORDER_ASSIGNED` and
   * `DRIVER_STOP_DETECTED` alike — so the driver's list would render
   * permanently empty. `recipientUserId` comes from the authenticated token
   * and is the real per-user boundary; for a CLIENT it is
   * equivalent-or-tighter than the `companyId` filter, so this changes
   * nothing for that persona (FR-042).
   */
  async findForUser(
    recipientUserId: string,
    unreadOnly: boolean,
    cursor?: string,
  ): Promise<PaginatedResponse<NotificationDocument> & { unreadCount: number }> {
    const filter: Record<string, unknown> = { recipientUserId };
    if (unreadOnly) {
      filter.readAt = null;
    }
    return this.tenantContext.runUnscoped(async () => {
      const [page, unreadCount] = await Promise.all([
        paginate(this.notificationModel, filter, NOTIFICATION_SORT_KEYS, cursor),
        this.notificationModel.countDocuments({ recipientUserId, readAt: null }).exec(),
      ]);
      return { ...page, unreadCount };
    });
  }

  async markRead(id: string, recipientUserId: string): Promise<NotificationDocument> {
    // Same reasoning as `findForUser` — `recipientUserId` (from the token) is
    // the boundary, so a driver can mark their own fuel-company-scoped
    // notification read.
    const notification = await this.tenantContext.runUnscoped(() =>
      this.notificationModel
        .findOneAndUpdate({ _id: id, recipientUserId }, { readAt: new Date() }, { new: true })
        .exec(),
    );
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    return notification;
  }

  /**
   * feature 013 FR-025/FR-026: marks every unread notification read for the
   * calling user, returning the count actually transitioned.
   *
   * One conditional `updateMany` — idempotent by construction, since the
   * update falsifies its own filter, so a second call returns `{ updated: 0 }`
   * rather than an error. No transaction: there is no second document whose
   * consistency depends on this. The recipient is the authenticated
   * principal, never a parameter — a body-supplied recipient would be a
   * cross-tenant write dressed as a convenience.
   */
  async markAllRead(recipientUserId: string): Promise<{ updated: number }> {
    // `runUnscoped`, keyed strictly on `recipientUserId` — the same discipline
    // `notify` uses for the write. A notification's `companyId` is the
    // *order's* fuel company (every `notify` call site), which for a DRIVER
    // recipient is a different tenant from the driver's own `companyId` (their
    // transport company). With the ambient tenant filter on, a driver's
    // `updateMany` would match none of their own notifications.
    // `recipientUserId` comes from the authenticated token and is the real
    // per-user boundary here.
    const result = await this.tenantContext.runUnscoped(() =>
      this.notificationModel
        .updateMany({ recipientUserId, readAt: null }, { $set: { readAt: new Date() } })
        .exec(),
    );
    return { updated: result.modifiedCount };
  }
}
