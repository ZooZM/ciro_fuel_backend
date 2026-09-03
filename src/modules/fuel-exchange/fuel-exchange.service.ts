import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ExchangeRequest, ExchangeRequestDocument } from './schemas/exchange-request.schema';
import { ExchangeRequestState } from '../../common/enums/exchange-request-state.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { CompaniesService } from '../companies/companies.service';
import { CompanyType } from '../../common/enums/company-type.enum';
import { DEFAULT_CURRENCY } from '../../common/constants/money.constants';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { CursorSortField } from '../../common/pagination/cursor.util';

const EXCHANGE_SORT_KEYS: CursorSortField[] = [
  { field: 'createdAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];

export type ExchangeDirection = 'incoming' | 'outgoing' | 'all';

/**
 * spec 013 Phase 15 Part B (US12) — built only after Part A's isolation gate passed
 * (T217). Every read here relies on `party-set-scope.plugin.ts`'s ambient
 * `partyCompanyIds` filter; nothing in this service adds its own company-equality
 * check for isolation — see that plugin's own comment for what happens when a
 * collection like this one is scoped the wrong way instead.
 */
@Injectable()
export class FuelExchangeService {
  constructor(
    @InjectModel(ExchangeRequest.name) private readonly exchangeRequestModel: Model<ExchangeRequestDocument>,
    private readonly companiesService: CompaniesService,
  ) {}

  /**
   * T221/FR-078/FR-085/FR-086 — refuses a recipient that doesn't sell the grade
   * (`EXCHANGE_GRADE_NOT_SOLD`) before creating anything; the party-set plugin's own
   * `pre('save')` (T212) is the structural backstop that the acting company ends up IN
   * `partyCompanyIds`, not the primary check — this method always builds a valid pair.
   */
  async create(
    actingCompanyId: string,
    actingUserId: string,
    dto: {
      recipientCompanyId: string;
      fuelType: string;
      quantityLitres: number;
      unitPrice: number;
      deliveryAt: string;
      deliveryPlaceText: string;
    },
  ): Promise<ExchangeRequestDocument> {
    if (dto.recipientCompanyId === actingCompanyId) {
      throw new BadRequestException('A fuel company cannot raise an exchange request to itself');
    }
    const recipient = await this.companiesService.findById(dto.recipientCompanyId);
    if (recipient.type !== CompanyType.FUEL) {
      throw new BadRequestException('The recipient must be a fuel company');
    }
    const recipientSellsGrade = await this.companiesService.getBasePrice(
      dto.recipientCompanyId,
      dto.fuelType as never,
    );
    if (recipientSellsGrade === undefined) {
      throw new BadRequestException({
        error: ErrorCode.EXCHANGE_GRADE_NOT_SOLD,
        message: `The recipient does not sell ${dto.fuelType}`,
      });
    }

    return this.exchangeRequestModel.create({
      partyCompanyIds: [new Types.ObjectId(actingCompanyId), new Types.ObjectId(dto.recipientCompanyId)],
      raisedByCompanyId: new Types.ObjectId(actingCompanyId),
      recipientCompanyId: new Types.ObjectId(dto.recipientCompanyId),
      raisedByUserId: new Types.ObjectId(actingUserId),
      fuelType: dto.fuelType,
      quantityLitres: dto.quantityLitres,
      unitPrice: dto.unitPrice,
      currency: DEFAULT_CURRENCY,
      deliveryAt: new Date(dto.deliveryAt),
      deliveryPlaceText: dto.deliveryPlaceText,
      state: ExchangeRequestState.AWAITING_RESPONSE,
    });
  }

  /**
   * T222/FR-079/FR-084 — direction is DERIVED against the viewer at read time, never
   * stored per-viewer: `raisedByCompanyId === actingCompanyId` means outgoing, otherwise
   * (since the party-set plugin already guarantees the viewer IS one of the two parties)
   * it is incoming.
   */
  findForUser(
    actingCompanyId: string,
    direction: ExchangeDirection,
    cursor: string | undefined,
  ): Promise<PaginatedResponse<ExchangeRequestDocument>> {
    const query: Record<string, unknown> = {};
    if (direction === 'outgoing') {
      query.raisedByCompanyId = new Types.ObjectId(actingCompanyId);
    } else if (direction === 'incoming') {
      query.recipientCompanyId = new Types.ObjectId(actingCompanyId);
    }
    return paginate(this.exchangeRequestModel, query, EXCHANGE_SORT_KEYS, cursor);
  }

  /** T223/FR-086b — the party-set plugin's own scoping IS the isolation refusal
   * (Constitution II: a cross-party id resolves to nothing, a 404 indistinguishable
   * from a genuinely nonexistent one, never a 403 that would confirm existence). */
  async findById(id: string): Promise<ExchangeRequestDocument> {
    const request = await this.exchangeRequestModel.findById(id).exec();
    if (!request) {
      throw new NotFoundException('Exchange request not found');
    }
    return request;
  }

  /** T224/FR-080/FR-082 — recipient-only, conditional on `AWAITING_RESPONSE`.
   * `EXCHANGE_ALREADY_RESOLVED` on a state conflict; a raiser calling this (not the
   * recipient) gets a distinct, real 403 rather than being folded into the same 409. */
  async respond(id: string, actingCompanyId: string, actingUserId: string, accept: boolean): Promise<ExchangeRequestDocument> {
    const request = await this.findById(id);
    if (String(request.recipientCompanyId) !== actingCompanyId) {
      throw new ForbiddenException('Only the recipient may respond to this exchange request');
    }
    const result = await this.exchangeRequestModel
      .findOneAndUpdate(
        { _id: id, state: ExchangeRequestState.AWAITING_RESPONSE },
        {
          $set: {
            state: accept ? ExchangeRequestState.ACCEPTED : ExchangeRequestState.DECLINED,
            resolvedBy: new Types.ObjectId(actingUserId),
            resolvedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    if (!result) {
      throw new ConflictException({
        error: ErrorCode.EXCHANGE_ALREADY_RESOLVED,
        message: 'This exchange request has already been resolved',
      });
    }
    // T226/FR-086a: no order, delivery, transport assignment or invoice is ever created
    // here, on acceptance or otherwise — this method's entire effect is the state write
    // above. `deliveryAt`/`deliveryPlaceText` remain terms of the agreement, never read
    // by anything else on the platform.
    return result;
  }

  /** T225/FR-081/FR-082 — raiser-only, the same conditional idiom as {@link respond}. */
  async withdraw(id: string, actingCompanyId: string, actingUserId: string): Promise<ExchangeRequestDocument> {
    const request = await this.findById(id);
    if (String(request.raisedByCompanyId) !== actingCompanyId) {
      throw new ForbiddenException('Only the company that raised this exchange request may withdraw it');
    }
    const result = await this.exchangeRequestModel
      .findOneAndUpdate(
        { _id: id, state: ExchangeRequestState.AWAITING_RESPONSE },
        {
          $set: {
            state: ExchangeRequestState.WITHDRAWN,
            resolvedBy: new Types.ObjectId(actingUserId),
            resolvedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    if (!result) {
      throw new ConflictException({
        error: ErrorCode.EXCHANGE_ALREADY_RESOLVED,
        message: 'This exchange request has already been resolved',
      });
    }
    return result;
  }
}
