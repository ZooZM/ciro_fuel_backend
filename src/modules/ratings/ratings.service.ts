import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { DeliveryRating, DeliveryRatingDocument } from './schemas/delivery-rating.schema';
import { OrderDocument } from '../orders/schemas/order.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { TenantContextService } from '../../common/context/tenant-context.service';

export interface SubmitRatingInput {
  score: number;
  review?: string;
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * spec 007 US6 (data-model.md "Aggregate update rule"): inserts the rating
 * and bumps the driver's `ratingAverage`/`ratingCount` in one
 * `ClientSession` (Principle V) — a rating without its aggregate bump would
 * show feedback that never affects standing; a bump without its rating
 * would be an unattributable score.
 */
@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(
    @InjectModel(DeliveryRating.name) private readonly ratingModel: Model<DeliveryRatingDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly tenantContext: TenantContextService,
  ) {}

  async submitRating(
    order: OrderDocument,
    clientId: string,
    input: SubmitRatingInput,
  ): Promise<DeliveryRatingDocument> {
    if (order.status !== OrderStatus.DELIVERED) {
      throw new ConflictException({
        error: ErrorCode.ORDER_NOT_DELIVERED,
        message: 'This delivery has not been completed yet',
      });
    }

    const session = await this.connection.startSession();
    try {
      let rating!: DeliveryRatingDocument;
      await session.withTransaction(async () => {
        try {
          const created = await this.ratingModel.create(
            [
              {
                orderId: order._id,
                driverId: order.driverId,
                clientId: order.clientId,
                fuelCompanyId: order.fuelCompanyId,
                transportCompanyId: order.transportCompanyId,
                score: input.score,
                review: input.review,
              },
            ],
            { session },
          );
          rating = created[0];
        } catch (err) {
          // FR-039's actual enforcement point (data-model.md): a duplicate
          // insert is rejected by the unique index on `orderId` itself —
          // never by a prior existence check, which two concurrent
          // submissions for the same order would both pass.
          if (isDuplicateKeyError(err)) {
            throw new ConflictException({
              error: ErrorCode.ALREADY_RATED,
              message: 'This delivery has already been rated',
            });
          }
          throw err;
        }

        // Unscoped: the rating client (a Fuel Company tenant) and the
        // driver being rated (a Transport Company tenant) never share a
        // `companyId` — the single-tenant plugin's ambient filter would
        // otherwise match nothing, exactly the bug already found and fixed
        // once in dispatch.service.ts's clientSummary lookup.
        const driver = await this.tenantContext.runUnscoped(() =>
          this.userModel.findById(order.driverId).session(session).exec(),
        );
        if (!driver) {
          this.logger.warn(
            `Rating submitted for a driver that no longer exists: ${order.driverId}`,
          );
          return;
        }
        const priorCount = driver.ratingCount ?? 0;
        const priorAverage = driver.ratingAverage ?? 0;
        const newCount = priorCount + 1;
        const newAverage = (priorAverage * priorCount + input.score) / newCount;
        await this.tenantContext.runUnscoped(() =>
          this.userModel
            .updateOne(
              { _id: driver._id },
              { $set: { ratingAverage: newAverage, ratingCount: newCount } },
              { session },
            )
            .exec(),
        );
      });
      return rating;
    } finally {
      await session.endSession();
    }
  }

  /** The rating attached to one order, if any — for both personas to read off the delivery itself. */
  findByOrderId(orderId: string): Promise<DeliveryRatingDocument | null> {
    return this.ratingModel.findOne({ orderId }).exec();
  }
}
