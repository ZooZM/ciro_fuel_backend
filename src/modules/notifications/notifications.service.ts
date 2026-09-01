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
  async findForUser(
    recipientUserId: string,
    unreadOnly: boolean,
    cursor?: string,
  ): Promise<PaginatedResponse<NotificationDocument> & { unreadCount: number }> {
    const filter: Record<string, unknown> = { recipientUserId };
    if (unreadOnly) {
      filter.readAt = null;
    }
    const [page, unreadCount] = await Promise.all([
      paginate(this.notificationModel, filter, NOTIFICATION_SORT_KEYS, cursor),
      this.notificationModel.countDocuments({ recipientUserId, readAt: null }).exec(),
    ]);
    return { ...page, unreadCount };
  }

  async markRead(id: string, recipientUserId: string): Promise<NotificationDocument> {
    const notification = await this.notificationModel
      .findOneAndUpdate({ _id: id, recipientUserId }, { readAt: new Date() }, { new: true })
      .exec();
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    return notification;
  }
}
