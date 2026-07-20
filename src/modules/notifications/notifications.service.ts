import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification, NotificationDocument } from './schemas/notification.schema';
import { NotificationType } from '../../common/enums/notification-type.enum';
import { RealtimeGatewayService } from '../../common/realtime/realtime-gateway.service';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    private readonly realtimeGateway: RealtimeGatewayService,
  ) {}

  /**
   * Explicitly takes companyId rather than relying on the tenant plugin,
   * because most callers (BullMQ processors, webhook handlers, dispatch
   * service) run outside an HTTP request's AsyncLocalStorage context.
   */
  async notify(params: {
    companyId: string | Types.ObjectId;
    recipientUserId: string | Types.ObjectId;
    type: NotificationType;
    orderId?: string | Types.ObjectId;
    payload?: Record<string, unknown>;
  }): Promise<NotificationDocument> {
    const notification = await this.notificationModel.create({
      companyId: params.companyId,
      recipientUserId: params.recipientUserId,
      type: params.type,
      orderId: params.orderId,
      payload: params.payload ?? {},
    });
    this.realtimeGateway.emitToUser(String(params.recipientUserId), 'notification:new', {
      id: String(notification._id),
      type: notification.type,
      orderId: params.orderId ? String(params.orderId) : undefined,
      payload: notification.payload,
    });
    return notification;
  }

  findForUser(recipientUserId: string, unreadOnly: boolean): Promise<NotificationDocument[]> {
    const filter: Record<string, unknown> = { recipientUserId };
    if (unreadOnly) {
      filter.readAt = null;
    }
    return this.notificationModel.find(filter).sort({ createdAt: -1 }).exec();
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
