import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  CreditLimitRequest,
  CreditLimitRequestDocument,
} from '../schemas/credit-limit-request.schema';
import { CreditLimitRequestState } from '../../../common/enums/credit-limit-request-state.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { UsersService } from '../users.service';

/**
 * spec 013 (fuel company admin dashboard) FR-029/FR-030/FR-031, US3 — a station owner's
 * request for a higher credit limit, and the administrator's resolution of it. Genuine
 * new platform capability: credit limits themselves already exist on `User`
 * (`SetCreditLimitDto`); the request-and-resolve exchange did not.
 */
@Injectable()
export class CreditLimitRequestsService {
  constructor(
    @InjectModel(CreditLimitRequest.name)
    private readonly requestModel: Model<CreditLimitRequestDocument>,
    private readonly usersService: UsersService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** FR-029: refuses a second request while one is already PENDING. */
  async create(
    clientId: string,
    companyId: string,
    requestedAmount: number,
  ): Promise<CreditLimitRequestDocument> {
    const existing = await this.requestModel
      .findOne({ clientId: new Types.ObjectId(clientId), state: CreditLimitRequestState.PENDING })
      .exec();
    if (existing) {
      throw new ConflictException({
        error: ErrorCode.LIMIT_REQUEST_ALREADY_RESOLVED,
        message: 'A credit limit request is already pending',
      });
    }
    return this.requestModel.create({
      companyId: new Types.ObjectId(companyId),
      clientId: new Types.ObjectId(clientId),
      requestedAmount,
    });
  }

  /** The administrator's queue (FR-030), optionally filtered by state. */
  findForCompany(state?: CreditLimitRequestState): Promise<CreditLimitRequestDocument[]> {
    return this.requestModel
      .find(state ? { state } : {})
      .sort({ createdAt: -1 })
      .exec();
  }

  /** The owner's own history and outcomes (FR-029). */
  findForClient(clientId: string): Promise<CreditLimitRequestDocument[]> {
    return this.requestModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * FR-030/FR-031/SC-008/Principle V: a conditional update filtered on `state: PENDING`
   * — `modifiedCount` (via `findOneAndUpdate`'s null return) decides which of two
   * concurrent resolutions wins, never a read-then-write. Accepting writes the new
   * credit limit on the `User` and the resolution on the request inside ONE
   * transaction (T065) — a crash between the two writes must never leave an ACCEPTED
   * request whose grant was never actually applied to the owner's real limit.
   */
  async resolve(
    id: string,
    resolvedBy: string,
    accept: boolean,
    grantedAmount?: number,
  ): Promise<CreditLimitRequestDocument> {
    const request = await this.requestModel.findById(id).exec();
    if (!request) {
      throw new NotFoundException('Credit limit request not found');
    }

    const update = accept
      ? {
          state: CreditLimitRequestState.ACCEPTED,
          grantedAmount: grantedAmount ?? request.requestedAmount,
          resolvedBy: new Types.ObjectId(resolvedBy),
          resolvedAt: new Date(),
        }
      : {
          state: CreditLimitRequestState.REJECTED,
          resolvedBy: new Types.ObjectId(resolvedBy),
          resolvedAt: new Date(),
        };

    const session = await this.connection.startSession();
    let resolved!: CreditLimitRequestDocument;
    try {
      await session.withTransaction(async () => {
        const result = await this.requestModel
          .findOneAndUpdate(
            { _id: id, state: CreditLimitRequestState.PENDING },
            { $set: update },
            { new: true, session },
          )
          .exec();
        if (!result) {
          throw new ConflictException({
            error: ErrorCode.LIMIT_REQUEST_ALREADY_RESOLVED,
            message: 'This request has already been resolved',
          });
        }
        resolved = result;

        if (accept) {
          await this.usersService.setCreditLimit(
            resolved.clientId.toString(),
            resolved.grantedAmount!,
            session,
          );
        }
      });
    } finally {
      await session.endSession();
    }

    return resolved;
  }
}
