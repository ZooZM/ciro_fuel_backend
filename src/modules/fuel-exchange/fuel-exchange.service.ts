import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, FilterQuery, Model, Types } from 'mongoose';
import { ExchangeOffer, ExchangeOfferDocument } from './schemas/exchange-offer.schema';
import { ExchangeProposal, ExchangeProposalDocument } from './schemas/exchange-proposal.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { ExchangeOfferState } from '../../common/enums/exchange-offer-state.enum';
import { ProposalOutcome } from '../../common/enums/proposal-outcome.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { NotificationType } from '../../common/enums/notification-type.enum';
import { UserRole } from '../../common/enums/user-role.enum';
import { CompaniesService } from '../companies/companies.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { DEFAULT_CURRENCY, roundCurrency } from '../../common/constants/money.constants';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { CursorSortField } from '../../common/pagination/cursor.util';
import { isDuplicateKeyError } from '../../common/utils/mongo-error.util';
import { CreateOfferDto } from './dto/create-offer.dto';
import { CreateProposalDto } from './dto/create-proposal.dto';

const EXCHANGE_SORT_KEYS: CursorSortField[] = [
  { field: 'createdAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];

export type ExchangeDirection = 'incoming' | 'outgoing' | 'all';

interface CompanyContact {
  name: string;
  contactEmail: string;
  contactPhone: string;
}

/**
 * spec 016 (broadcast fuel exchange offers) — replaces the directed `ExchangeRequest`
 * flow (spec 014's US12/T217-T229). Every read here relies on the AMENDED
 * `party-set-scope.plugin.ts` (offer) and the new `proposal-scope.plugin.ts`
 * (proposal); nothing in this service adds its own company-equality check for
 * isolation. Grade eligibility, by contrast, IS a service-layer concern
 * (research R2) — it is a relevance filter, not a confidentiality boundary.
 */
@Injectable()
export class FuelExchangeService {
  constructor(
    @InjectModel(ExchangeOffer.name) private readonly offerModel: Model<ExchangeOfferDocument>,
    @InjectModel(ExchangeProposal.name) private readonly proposalModel: Model<ExchangeProposalDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly companiesService: CompaniesService,
    private readonly notificationsService: NotificationsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // ======================================================================
  // US1 — raise (T028/T029)
  // ======================================================================

  /** T028/T029/FR-001/FR-003/FR-004/FR-005/FR-005a/FR-018 — no price field anywhere;
   * refuses when no OTHER fuel company sells the grade at all. */
  async create(
    actingCompanyId: string,
    actingUserId: string,
    dto: CreateOfferDto,
  ): Promise<ExchangeOfferDocument> {
    const deliveryAt = new Date(dto.deliveryAt);
    if (deliveryAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        error: ErrorCode.EXCHANGE_DELIVERY_IN_PAST,
        message: 'deliveryAt must be in the future',
      });
    }

    const eligible = await this.companiesService.findActiveFuelCompaniesSellingGrade(
      dto.fuelType,
      actingCompanyId,
    );
    if (eligible.length === 0) {
      throw new BadRequestException({
        error: ErrorCode.EXCHANGE_NO_ELIGIBLE_COMPANY,
        message: `No other fuel company on the platform sells ${dto.fuelType}`,
      });
    }

    const offer = await this.offerModel.create({
      openToMarket: true,
      partyCompanyIds: [new Types.ObjectId(actingCompanyId)],
      raisedByCompanyId: new Types.ObjectId(actingCompanyId),
      raisedByUserId: new Types.ObjectId(actingUserId),
      fuelType: dto.fuelType,
      quantityLitres: dto.quantityLitres,
      deliveryAt,
      city: dto.city,
      district: dto.district,
      locationUrl: dto.locationUrl,
      notes: dto.notes,
      state: ExchangeOfferState.OPEN,
    });

    // T036a/FR-029: fans out to every eligible company just resolved above — the SAME
    // set the eligibility check already proved is non-empty.
    const admins = await this.resolveRecipientAdmins(eligible.map((c) => c._id as Types.ObjectId));
    await this.notifyMany(admins, NotificationType.EXCHANGE_OFFER_AVAILABLE, {
      offerId: String(offer._id),
    });

    return offer;
  }

  // ======================================================================
  // Listing (T031/T032/T032a/T081)
  // ======================================================================

  /**
   * T032/research R2 — the grade RELEVANCE filter (never the confidentiality
   * boundary — that is the plugin's job) plus T032a's suspended-raiser exclusion.
   * Shared by `findAll('incoming'|'all')` and `summary()` so the two can never
   * silently disagree about what "incoming" means.
   *
   * The disjunction below is deliberately nested under `$and` rather than a
   * top-level `$or`: `party-set-scope.plugin.ts` injects its OWN top-level `$or`
   * for every scoped read via `Query.where({ $or: [...] })`, and Mongoose's
   * `where()` REPLACES an existing top-level key of the same name rather than
   * combining it — a bare `$or` here would be silently discarded the moment the
   * plugin's pre-hook runs, wiping out the entire grade-relevance filter (found by
   * this feature's own e2e suite: company C, diesel-only, was seeing a PETROL_95
   * market offer in its incoming list before this fix).
   */
  private async buildIncomingFilter(actingCompanyId: string): Promise<FilterQuery<ExchangeOfferDocument>> {
    const acting = new Types.ObjectId(actingCompanyId);
    const [suspended, company] = await Promise.all([
      this.companiesService.findSuspendedFuelCompanyIds(),
      this.companiesService.findById(actingCompanyId),
    ]);
    const soldGrades = (company.fuelPrices ?? []).map((p) => p.fuelType);
    const suspendedIds = suspended.map((c) => c._id);

    return {
      raisedByCompanyId: { $nin: [...suspendedIds, acting] },
      $and: [
        {
          // A migrated two-party offer (openToMarket:false) was already targeted at
          // THIS company specifically — its own eligibility was decided at raise
          // time, under the directed model, so grade relevance never re-applies to
          // it. A market offer is relevance-filtered by the viewer's OWN current
          // sold grades (FR-007).
          $or: [{ openToMarket: false }, { openToMarket: true, fuelType: { $in: soldGrades } }],
        },
      ],
    };
  }

  /** T031/FR-008/FR-034 — direction is DERIVED per viewer, never stored. */
  async findAll(
    actingCompanyId: string,
    direction: ExchangeDirection,
    state: ExchangeOfferState | undefined,
    cursor: string | undefined,
  ): Promise<PaginatedResponse<ExchangeOfferDocument>> {
    const outgoingFilter: FilterQuery<ExchangeOfferDocument> = {
      raisedByCompanyId: new Types.ObjectId(actingCompanyId),
    };

    let filter: FilterQuery<ExchangeOfferDocument>;
    let effectiveState = state;
    if (direction === 'outgoing') {
      filter = outgoingFilter;
    } else if (direction === 'incoming') {
      filter = await this.buildIncomingFilter(actingCompanyId);
      // FR-016: a withdrawn (or otherwise resolved) offer MUST stop reaching every
      // company — "incoming" means "currently awaiting my answer" by default. An
      // explicit `?state=` still overrides this, for a company reviewing what it was
      // once invited to. `outgoing`/`all` are never defaulted this way: the raiser's
      // OWN tracking (US4) needs its full history, open or closed.
      effectiveState = state ?? ExchangeOfferState.OPEN;
    } else {
      // Nested under `$and` for the same reason `buildIncomingFilter` is — a
      // top-level `$or` here would be overwritten by the isolation plugin's own.
      filter = { $and: [{ $or: [outgoingFilter, await this.buildIncomingFilter(actingCompanyId)] }] };
    }
    if (effectiveState) {
      filter = { $and: [filter, { state: effectiveState }] };
    }

    const page = await paginate(this.offerModel, filter, EXCHANGE_SORT_KEYS, cursor);
    const items = await this.shapeListItems(page.items, actingCompanyId);
    return { items: items as never, nextCursor: page.nextCursor };
  }

  /** SUPER_ADMIN's own listing — read-only, every company, no direction (FR-023). */
  async findAllForOperator(cursor: string | undefined): Promise<PaginatedResponse<ExchangeOfferDocument>> {
    return paginate(this.offerModel, {}, EXCHANGE_SORT_KEYS, cursor);
  }

  /**
   * T081/FR-021a — attaches `proposalCount`/`declineCount` ONLY to items the viewer
   * raised, and `raisedByCompanyName` to every item (FR-019: a company name alone is
   * never a disclosure boundary). Built from the viewer directly, never stripped
   * afterward (the T052 discipline this whole module follows).
   */
  private async shapeListItems(
    offers: ExchangeOfferDocument[],
    actingCompanyId: string,
  ): Promise<Record<string, unknown>[]> {
    if (offers.length === 0) return [];

    const raiserIds = [...new Set(offers.map((o) => String(o.raisedByCompanyId)))];
    const names = new Map<string, string>();
    await Promise.all(
      raiserIds.map(async (id) => {
        const company = await this.companiesService.findById(id);
        names.set(id, company.name);
      }),
    );

    return Promise.all(
      offers.map(async (offer) => {
        const isRaiser = String(offer.raisedByCompanyId) === actingCompanyId;
        const includeAgreed =
          isRaiser || (offer.state === ExchangeOfferState.AWARDED && String(offer.awardedCompanyId) === actingCompanyId);
        const item = this.toOfferSummary(offer, { includeAgreed });
        item.raisedByCompanyName = names.get(String(offer.raisedByCompanyId));

        if (isRaiser) {
          const [proposalCount, declineCount] = await Promise.all([
            this.proposalModel.countDocuments({ offerId: offer._id, outcome: { $ne: ProposalOutcome.DECLINED } }).exec(),
            this.proposalModel.countDocuments({ offerId: offer._id, outcome: ProposalOutcome.DECLINED }).exec(),
          ]);
          item.proposalCount = proposalCount;
          item.declineCount = declineCount;
        }
        return item;
      }),
    );
  }

  /**
   * Builds the offer's own fields explicitly — never the whole document spread and
   * then stripped. `includeAgreed` is the ONLY switch on the agreed figures and
   * `awardedCompanyId`; a non-winning recipient of an awarded offer must never see
   * either (FR-015).
   */
  private toOfferSummary(
    offer: ExchangeOfferDocument,
    opts: { includeAgreed: boolean },
  ): Record<string, unknown> {
    const doc = offer as ExchangeOfferDocument & { createdAt?: Date; updatedAt?: Date };
    const summary: Record<string, unknown> = {
      _id: offer._id,
      openToMarket: offer.openToMarket,
      raisedByCompanyId: offer.raisedByCompanyId,
      fuelType: offer.fuelType,
      quantityLitres: offer.quantityLitres,
      deliveryAt: offer.deliveryAt,
      city: offer.city,
      district: offer.district,
      locationUrl: offer.locationUrl,
      notes: offer.notes,
      state: offer.state,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    if (opts.includeAgreed) {
      summary.awardedCompanyId = offer.awardedCompanyId;
      summary.agreedUnitPrice = offer.agreedUnitPrice;
      summary.agreedTotal = offer.agreedTotal;
      summary.agreedQuantityLitres = offer.agreedQuantityLitres;
      summary.currency = offer.currency;
    }
    return summary;
  }

  /**
   * `revealIdentity` gates `proposingCompanyId` itself, not merely the `company`
   * contact object — FR-021 forbids the raiser learning WHICH company declined, and
   * the raw id is exactly as identifying as a name (found while testing T081a: an
   * earlier version always included `proposingCompanyId`, leaking a declining
   * company's identity even though it never attached `company` contact details).
   * `true` for a priced proposal shown to the raiser and for a company's view of its
   * OWN submission (never a leak — it is already their own id); `false` for a
   * decline shown to the raiser.
   */
  private toProposalShape(
    proposal: ExchangeProposalDocument,
    offerQuantityLitres: number,
    opts: { revealIdentity: boolean; company?: CompanyContact } = { revealIdentity: true },
  ): Record<string, unknown> {
    const shape: Record<string, unknown> = {
      _id: proposal._id,
      outcome: proposal.outcome,
      respondedAt: proposal.respondedAt,
    };
    if (opts.revealIdentity) {
      shape.proposingCompanyId = proposal.proposingCompanyId;
    }
    if (proposal.unitPrice !== undefined) {
      shape.unitPrice = proposal.unitPrice;
      shape.currency = proposal.currency;
      shape.total = roundCurrency(proposal.unitPrice * offerQuantityLitres);
    }
    if (opts.company) {
      shape.company = opts.company;
    }
    return shape;
  }

  // ======================================================================
  // Detail (T034/T052/T067)
  // ======================================================================

  /**
   * T034/T052/T067/FR-020/FR-021a/FR-022/FR-019/FR-019a/FR-015 — the viewer-shaped
   * payload table in `contracts/rest-api-delta.md`. A non-entitled viewer already
   * gets `null` from `findById` (the plugin's own scoping), surfaced as 404 by the
   * controller — never distinguishable from absence.
   */
  async findOne(
    id: string,
    actingCompanyId: string | undefined,
    role: UserRole,
  ): Promise<Record<string, unknown>> {
    const offer = await this.offerModel.findById(id).exec();
    if (!offer) {
      throw new NotFoundException('Exchange offer not found');
    }
    return this.buildDetail(offer, actingCompanyId, role);
  }

  private async buildDetail(
    offer: ExchangeOfferDocument,
    actingCompanyId: string | undefined,
    role: UserRole,
  ): Promise<Record<string, unknown>> {
    const isSuperAdmin = role === UserRole.SUPER_ADMIN;
    const isRaiser = !isSuperAdmin && actingCompanyId === String(offer.raisedByCompanyId);
    const isAwardedCompany =
      !isSuperAdmin &&
      !isRaiser &&
      offer.state === ExchangeOfferState.AWARDED &&
      actingCompanyId === String(offer.awardedCompanyId);

    const raiserCompany = await this.companiesService.findById(offer.raisedByCompanyId);
    const result = this.toOfferSummary(offer, { includeAgreed: isRaiser || isSuperAdmin || isAwardedCompany });
    // FR-019: a company NAME alone is disclosed regardless of state — contact
    // details are the boundary, gated below.
    result.raisedByCompanyName = raiserCompany.name;

    if (isRaiser || isSuperAdmin) {
      const proposals = await this.proposalModel.find({ offerId: offer._id }).exec();
      result.proposals = await Promise.all(
        proposals.map(async (p) => {
          // FR-021/FR-021a: the raiser learns a decline occurred, and NOTHING else
          // about it — never the declining company's identity (not even the raw id)
          // or contact details. Only a priced proposal's company is resolved and
          // attached.
          if (p.outcome === ProposalOutcome.DECLINED) {
            return this.toProposalShape(p, offer.quantityLitres, { revealIdentity: false });
          }
          const company = await this.companiesService.findById(p.proposingCompanyId);
          return this.toProposalShape(p, offer.quantityLitres, {
            revealIdentity: true,
            company: { name: company.name, contactEmail: company.contactEmail, contactPhone: company.contactPhone },
          });
        }),
      );
      result.proposalCount = proposals.filter((p) => p.outcome !== ProposalOutcome.DECLINED).length;
      result.declineCount = proposals.filter((p) => p.outcome === ProposalOutcome.DECLINED).length;
      return result;
    }

    // A genuine recipient (or SUPER_ADMIN already handled above) — own proposal only.
    if (actingCompanyId) {
      const own = await this.proposalModel
        .findOne({ offerId: offer._id, proposingCompanyId: new Types.ObjectId(actingCompanyId) })
        .exec();
      if (own) {
        result.myProposal = this.toProposalShape(own, offer.quantityLitres);
      }
    }

    // FR-019a: the awarded company alone sees the raiser's contact details.
    if (isAwardedCompany) {
      result.raiserContact = {
        name: raiserCompany.name,
        contactEmail: raiserCompany.contactEmail,
        contactPhone: raiserCompany.contactPhone,
      };
    }

    return result;
  }

  // ======================================================================
  // US2 — propose / decline, blind (T047-T050a, T053, T056a)
  // ======================================================================

  /** T047/T048/T049/T049a/T050/FR-009/FR-010/FR-011/FR-011a/FR-013 */
  async propose(
    offerId: string,
    actingCompanyId: string,
    actingUserId: string,
    dto: CreateProposalDto,
  ): Promise<ExchangeProposalDocument> {
    const offer = await this.offerModel.findById(offerId).exec();
    if (!offer) {
      throw new NotFoundException('Exchange offer not found');
    }
    if (String(offer.raisedByCompanyId) === actingCompanyId) {
      throw new ForbiddenException('The raising company cannot answer its own offer');
    }
    if (offer.state !== ExchangeOfferState.OPEN) {
      throw new ConflictException({
        error: ErrorCode.EXCHANGE_OFFER_NOT_OPEN,
        message: 'This offer is not open',
      });
    }
    // T049a/research R13 — the raiser is the only party entitled to award; if it is
    // suspended, the offer would otherwise keep drawing proposals it can never resolve.
    const raiserActive = await this.companiesService.isActive(offer.raisedByCompanyId);
    if (!raiserActive) {
      throw new ConflictException({
        error: ErrorCode.EXCHANGE_OFFER_NOT_OPEN,
        message: 'The raising company is suspended',
      });
    }

    const isDecline = dto.decline === true;
    if (isDecline === (dto.unitPrice !== undefined)) {
      throw new BadRequestException('Provide exactly one of unitPrice or decline');
    }
    if (!isDecline) {
      // research R2 — the grade guard lives HERE, not at raise time.
      const sellsGrade = await this.companiesService.getBasePrice(actingCompanyId, offer.fuelType);
      if (sellsGrade === undefined) {
        throw new BadRequestException({
          error: ErrorCode.EXCHANGE_GRADE_NOT_SOLD,
          message: `Your company does not sell ${offer.fuelType}`,
        });
      }
    }

    let proposal: ExchangeProposalDocument;
    try {
      proposal = await this.proposalModel.create({
        offerId: offer._id,
        offerRaisedByCompanyId: offer.raisedByCompanyId,
        proposingCompanyId: new Types.ObjectId(actingCompanyId),
        proposingUserId: new Types.ObjectId(actingUserId),
        outcome: isDecline ? ProposalOutcome.DECLINED : ProposalOutcome.PROPOSED,
        ...(isDecline ? {} : { unitPrice: dto.unitPrice, currency: DEFAULT_CURRENCY }),
        respondedAt: new Date(),
      });
    } catch (err) {
      // T050/FR-011c/FR-018 — the unique (offerId, proposingCompanyId) index, not a
      // prior existence check two concurrent submissions could both pass identically.
      if (isDuplicateKeyError(err)) {
        throw new ConflictException({
          error: ErrorCode.EXCHANGE_ALREADY_ANSWERED,
          message: 'You have already answered this offer',
        });
      }
      throw err;
    }

    // T053/T056a/FR-030 — the raiser is a DIFFERENT tenant from the proposer; the
    // cross-tenant resolver is required here too, never a same-tenant lookup.
    const admins = await this.resolveRecipientAdmins([offer.raisedByCompanyId]);
    await this.notifyMany(admins, NotificationType.EXCHANGE_PROPOSAL_RECEIVED, {
      offerId: String(offer._id),
    });

    return proposal;
  }

  // ======================================================================
  // US3 — award (T061-T068)
  // ======================================================================

  /** T061-T066/FR-014/FR-014a/FR-014b/FR-014c/research R4/R7 */
  async award(
    offerId: string,
    actingCompanyId: string,
    actingUserId: string,
    proposalId: string,
  ): Promise<ExchangeOfferDocument> {
    const offer = await this.offerModel.findById(offerId).exec();
    if (!offer || String(offer.raisedByCompanyId) !== actingCompanyId) {
      // T065 — reveals nothing about whether the offer exists to a non-raiser.
      throw new NotFoundException('Exchange offer not found');
    }
    // Deliberately NOT filtered to `outcome: PROPOSED` — a second award attempt
    // naming the SAME (now-AWARDED) proposal must fall through to the offer's own
    // conditional update below and come back `409 EXCHANGE_ALREADY_RESOLVED`
    // (FR-014a), not a misleading 404 that looks like the proposal never existed. A
    // DECLINED proposal is the one outcome that can never be awarded, at any offer
    // state, so it alone is refused here.
    const proposal = await this.proposalModel.findOne({ _id: proposalId, offerId: offer._id }).exec();
    if (!proposal || proposal.outcome === ProposalOutcome.DECLINED) {
      throw new NotFoundException('Proposal not found');
    }

    const total = roundCurrency(proposal.unitPrice! * offer.quantityLitres);
    const now = new Date();

    const session = await this.connection.startSession();
    let updatedOffer!: ExchangeOfferDocument;
    try {
      await session.withTransaction(async () => {
        // T062/research R4 — conditional update; `modifiedCount` (via the null
        // return) decides, NEVER a prior read. This is the whole of the race guard.
        const result = await this.offerModel
          .findOneAndUpdate(
            { _id: offer._id, state: ExchangeOfferState.OPEN },
            {
              $set: {
                state: ExchangeOfferState.AWARDED,
                awardedProposalId: proposal._id,
                awardedCompanyId: proposal.proposingCompanyId,
                agreedUnitPrice: proposal.unitPrice,
                agreedTotal: total,
                agreedQuantityLitres: offer.quantityLitres,
                currency: proposal.currency,
                resolvedBy: new Types.ObjectId(actingUserId),
                resolvedAt: now,
              },
            },
            { new: true, session },
          )
          .exec();
        if (!result) {
          throw new ConflictException({
            error: ErrorCode.EXCHANGE_ALREADY_RESOLVED,
            message: 'This offer has already been resolved',
          });
        }
        updatedOffer = result;

        await this.proposalModel
          .updateOne(
            { _id: proposal._id },
            { $set: { outcome: ProposalOutcome.AWARDED, resolvedAt: now } },
            { session },
          )
          .exec();
        await this.proposalModel
          .updateMany(
            { offerId: offer._id, _id: { $ne: proposal._id } },
            { $set: { outcome: ProposalOutcome.NOT_SELECTED, resolvedAt: now } },
            { session },
          )
          .exec();
      });
    } finally {
      await session.endSession();
    }

    await this.notifyAward(updatedOffer, proposal.proposingCompanyId);
    return updatedOffer;
  }

  /** T068/FR-031 — the winner learns it won; every OTHER proposer learns only that
   * the offer closed, with no company name and no price. */
  private async notifyAward(offer: ExchangeOfferDocument, winnerCompanyId: Types.ObjectId): Promise<void> {
    const [winnerAdmins, losers] = await Promise.all([
      this.resolveRecipientAdmins([winnerCompanyId]),
      this.proposalModel
        .find({ offerId: offer._id, outcome: ProposalOutcome.NOT_SELECTED })
        .distinct('proposingCompanyId')
        .exec(),
    ]);
    const loserAdmins = await this.resolveRecipientAdmins(losers as Types.ObjectId[]);
    await Promise.all([
      this.notifyMany(winnerAdmins, NotificationType.EXCHANGE_OFFER_AWARDED, { offerId: String(offer._id) }),
      this.notifyMany(loserAdmins, NotificationType.EXCHANGE_OFFER_CLOSED, { offerId: String(offer._id) }),
    ]);
  }

  // ======================================================================
  // US4 — withdraw (T078-T080)
  // ======================================================================

  /** T078/T079/FR-014b/FR-016 — same conditional-update idiom as {@link award}. */
  async withdraw(offerId: string, actingCompanyId: string, actingUserId: string): Promise<ExchangeOfferDocument> {
    const offer = await this.offerModel.findById(offerId).exec();
    if (!offer || String(offer.raisedByCompanyId) !== actingCompanyId) {
      throw new NotFoundException('Exchange offer not found');
    }

    const result = await this.offerModel
      .findOneAndUpdate(
        { _id: offer._id, state: ExchangeOfferState.OPEN },
        {
          $set: {
            state: ExchangeOfferState.WITHDRAWN,
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
        message: 'This offer has already been resolved',
      });
    }

    // T080/FR-016/FR-030a — every company that had a LIVE (priced) proposal on it;
    // a company that already declined has nothing further to learn.
    const proposerIds = await this.proposalModel
      .find({ offerId: offer._id, outcome: ProposalOutcome.PROPOSED })
      .distinct('proposingCompanyId')
      .exec();
    const admins = await this.resolveRecipientAdmins(proposerIds as Types.ObjectId[]);
    await this.notifyMany(admins, NotificationType.EXCHANGE_OFFER_CLOSED, {
      offerId: String(offer._id),
      reason: 'WITHDRAWN',
    });

    return result;
  }

  // ======================================================================
  // US6 — summary (T091/T092)
  // ======================================================================

  /** T091/T092/FR-033/research R9 — three scoped counts over the WHOLE set, never a
   * page count. */
  async summary(actingCompanyId: string): Promise<{
    incomingAwaitingAnswer: number;
    outgoingOpen: number;
    awardedThisMonth: number;
  }> {
    const acting = new Types.ObjectId(actingCompanyId);
    const [incomingFilter, answeredOfferIds] = await Promise.all([
      this.buildIncomingFilter(actingCompanyId),
      this.proposalModel.find({ proposingCompanyId: acting }).distinct('offerId').exec(),
    ]);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const [incomingAwaitingAnswer, outgoingOpen, awardedThisMonth] = await Promise.all([
      this.offerModel
        .countDocuments({
          ...incomingFilter,
          state: ExchangeOfferState.OPEN,
          _id: { $nin: answeredOfferIds },
        })
        .exec(),
      this.offerModel.countDocuments({ raisedByCompanyId: acting, state: ExchangeOfferState.OPEN }).exec(),
      this.offerModel
        .countDocuments({
          // Nested under `$and` — see `buildIncomingFilter`'s comment: a top-level
          // `$or` is clobbered by the isolation plugin's own.
          $and: [{ $or: [{ raisedByCompanyId: acting }, { awardedCompanyId: acting }] }],
          state: ExchangeOfferState.AWARDED,
          // Boundary inclusive at the start, exclusive at the end (T092).
          resolvedAt: { $gte: monthStart, $lt: monthEnd },
        })
        .exec(),
    ]);

    return { incomingAwaitingAnswer, outgoingOpen, awardedThisMonth };
  }

  // ======================================================================
  // Cross-tenant notification fan-out (T036) — the trap research R6 documents
  // ======================================================================

  /**
   * T036/research R6 — a CROSS-TENANT lookup of every active `FUEL_COMPANY_ADMIN` in
   * the named companies. Deliberately does NOT reuse `SupportService`'s
   * `usersService.findAll({ role: FUEL_COMPANY_ADMIN })` pattern: that call runs
   * inside the ambient tenant context and would only ever return the ACTING
   * company's own administrators, silently notifying the wrong tenant while any "a
   * notification was created" assertion still passes. `runUnscoped` is required
   * here precisely because this query spans companies the ambient context has no
   * business narrowing to one of.
   */
  async resolveRecipientAdmins(companyIds: (string | Types.ObjectId)[]): Promise<UserDocument[]> {
    if (companyIds.length === 0) {
      return [];
    }
    const ids = companyIds.map((id) => new Types.ObjectId(String(id)));
    return this.tenantContext.runUnscoped(() =>
      this.userModel
        .find({ companyId: { $in: ids }, role: UserRole.FUEL_COMPANY_ADMIN, isActive: true })
        .exec(),
    );
  }

  private async notifyMany(
    admins: UserDocument[],
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          // `notify` itself wraps its create in `runUnscoped` and takes `companyId`
          // explicitly for exactly this reason — the RECIPIENT's own company, never
          // the acting company's (T036a).
          companyId: admin.companyId!,
          recipientUserId: admin._id as Types.ObjectId,
          type,
          payload,
        }),
      ),
    );
  }
}
