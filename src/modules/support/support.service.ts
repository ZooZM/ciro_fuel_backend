import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SupportRequest, SupportRequestDocument } from './schemas/support-request.schema';
import { SupportTopic } from '../../common/enums/support-topic.enum';
import { SupportRequestState } from '../../common/enums/support-request-state.enum';
import { NotificationType } from '../../common/enums/notification-type.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { UsersService } from '../users/users.service';
import { OrdersService } from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class SupportService {
  constructor(
    @InjectModel(SupportRequest.name)
    private readonly supportRequestModel: Model<SupportRequestDocument>,
    private readonly usersService: UsersService,
    private readonly ordersService: OrdersService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * FR-038/FR-038a/FR-038c. `orderId`, when given, is resolved through
   * `OrdersService.findById` under the caller's own (CLIENT) request
   * context — the multi-party plugin already scopes that read to
   * `clientId = req.user.sub`, so an order that isn't the caller's own
   * 404s here before a request is ever created, with no separate
   * ownership check to get wrong.
   */
  async create(
    clientId: string,
    companyId: string,
    dto: { topic: SupportTopic; message: string; orderId?: string },
  ): Promise<SupportRequestDocument> {
    if (dto.orderId) {
      await this.ordersService.findById(dto.orderId);
    }

    const request = await this.supportRequestModel.create({
      companyId: new Types.ObjectId(companyId),
      clientId: new Types.ObjectId(clientId),
      orderId: dto.orderId ? new Types.ObjectId(dto.orderId) : undefined,
      topic: dto.topic,
      message: dto.message,
    });

    await this.notifyFuelCompanyAdmins(companyId, request);
    return request;
  }

  /** FR-038b — the existing notification path, never a second delivery
   * mechanism, sent to every admin of the client's own fuel company. */
  private async notifyFuelCompanyAdmins(
    companyId: string,
    request: SupportRequestDocument,
  ): Promise<void> {
    const admins = await this.usersService.findAll({
      role: UserRole.FUEL_COMPANY_ADMIN,
      isActive: true,
    });
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          companyId,
          recipientUserId: admin._id as Types.ObjectId,
          type: NotificationType.SUPPORT_REQUEST_RAISED,
          orderId: request.orderId,
          payload: { supportRequestId: String(request._id), topic: request.topic },
        }),
      ),
    );
  }

  /** The caller's own requests, newest first (contract §8 — not paginated). */
  findForClient(clientId: string): Promise<SupportRequestDocument[]> {
    return this.supportRequestModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  /** FUEL_COMPANY_ADMIN — every request routed to their company (tenant
   * plugin scopes this to `companyId` automatically). */
  findForCompany(): Promise<SupportRequestDocument[]> {
    return this.supportRequestModel.find({}).sort({ createdAt: -1 }).exec();
  }

  /** FR-039a — SUBMITTED -> ACKNOWLEDGED only; already-acknowledged is a
   * no-op-shaped conflict rather than silently re-stamping who/when. */
  async acknowledge(id: string, adminId: string): Promise<SupportRequestDocument> {
    const request = await this.supportRequestModel.findById(id).exec();
    if (!request) {
      throw new NotFoundException('Support request not found');
    }
    if (request.state === SupportRequestState.ACKNOWLEDGED) {
      throw new ConflictException('Support request is already acknowledged');
    }
    request.state = SupportRequestState.ACKNOWLEDGED;
    request.acknowledgedAt = new Date();
    request.acknowledgedBy = new Types.ObjectId(adminId);
    await request.save();
    return request;
  }
}
