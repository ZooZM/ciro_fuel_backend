import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Company, CompanyDocument, DeliveryRate, PricingConfig } from './schemas/company.schema';
import { CompanyStatus } from '../../common/enums/company-status.enum';
import { CompanyType } from '../../common/enums/company-type.enum';
import { FuelType } from '../../common/enums/fuel-type.enum';
import { RegionCode } from '../../common/enums/region.enum';

export interface CompanyScopingInfo {
  isActive: boolean;
  type: CompanyType;
  /** Set only when `type === TRANSPORT`. */
  parentFuelCompanyId?: string;
}

@Injectable()
export class CompaniesService {
  constructor(@InjectModel(Company.name) private readonly companyModel: Model<CompanyDocument>) {}

  async findById(id: string | Types.ObjectId): Promise<CompanyDocument> {
    const company = await this.companyModel.findById(id).exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  async isActive(id: string | Types.ObjectId): Promise<boolean> {
    const company = await this.companyModel.findById(id).select('status').lean().exec();
    return company?.status === CompanyStatus.ACTIVE;
  }

  /**
   * One lookup covering everything the auth path needs to know about the
   * acting user's own company: whether it's suspended (existing behaviour,
   * unauthorized-if-not-active) and — new for spec 004 — its type and, for a
   * TRANSPORT company, the Fuel Company that owns it. Combined into a single
   * query rather than a separate one per fact, since both are read on every
   * authenticated request (`JwtStrategy.validate` → `validateActiveSession`).
   */
  /**
   * Display-only lookup for a driver's own profile (spec 006 FR-002) — the
   * company's name, nothing else. Non-throwing like {@link getScopingInfo}:
   * a profile screen must degrade gracefully (no company name shown) rather
   * than 404 the whole profile fetch if the lookup somehow misses.
   */
  async findNameById(id: string | Types.ObjectId): Promise<string | undefined> {
    const company = await this.companyModel.findById(id).select('name').lean().exec();
    return company?.name;
  }

  async getScopingInfo(id: string | Types.ObjectId): Promise<CompanyScopingInfo | undefined> {
    const company = await this.companyModel
      .findById(id)
      .select('status type parentFuelCompanyId')
      .lean()
      .exec();
    if (!company) {
      return undefined;
    }
    return {
      isActive: company.status === CompanyStatus.ACTIVE,
      type: company.type,
      parentFuelCompanyId: company.parentFuelCompanyId?.toString(),
    };
  }

  async getBasePrice(
    companyId: string | Types.ObjectId,
    fuelType: FuelType,
  ): Promise<number | undefined> {
    const company = await this.companyModel.findById(companyId).select('fuelPrices').lean().exec();
    return company?.fuelPrices.find((p) => p.fuelType === fuelType)?.basePricePerLiter;
  }

  /** `undefined` when unset — FR-011j's caller decides what that means (never a fabricated default). */
  async getPricingConfig(companyId: string | Types.ObjectId): Promise<PricingConfig | undefined> {
    const company = await this.companyModel
      .findById(companyId)
      .select('pricingConfig')
      .lean()
      .exec();
    return company?.pricingConfig;
  }

  async setPricingConfig(
    id: string,
    config: Omit<PricingConfig, 'updatedAt'>,
  ): Promise<CompanyDocument> {
    const company = await this.companyModel
      .findByIdAndUpdate(id, { pricingConfig: { ...config, updatedAt: new Date() } }, { new: true })
      .exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  async create(data: Partial<Company>, session?: ClientSession): Promise<CompanyDocument> {
    try {
      // Array form is the one that accepts options — `create(doc, options)` reads its
      // second argument as another DOCUMENT, so a session passed that way is silently
      // ignored and the write lands outside the transaction.
      const [company] = await this.companyModel.create([data], { session });
      return company;
    } catch (error) {
      throw CompaniesService.asConflict(error);
    }
  }

  /**
   * `name` is unique platform-wide (both Fuel and Transport companies share
   * the collection), so a collision on it is a client error, not a 500 —
   * the caller needs to know it was the name so they can pick another one.
   */
  private static asConflict(error: unknown): unknown {
    const { code, keyPattern } = (error ?? {}) as {
      code?: number;
      keyPattern?: Record<string, unknown>;
    };
    if (code !== 11000) {
      return error;
    }
    switch (Object.keys(keyPattern ?? {})[0]) {
      case 'name':
        return new ConflictException('A company with this name already exists');
      default:
        return new ConflictException('A company with these details already exists');
    }
  }

  /**
   * `Company` is deliberately NOT tenant-scoped by the Mongoose plugin (it
   * is the tenant root — there is nothing "above" it to scope against), so
   * this is the one place company-level visibility is enforced by hand: an
   * omitted `id` returns every company (CIRO only — spec 004 FR-003), a
   * given `id` narrows to at most that one (a Fuel Company admin sees only
   * themselves — FR-004a's boundary applied to listing, not just lookup).
   */
  findAll(id?: string): Promise<CompanyDocument[]> {
    return this.companyModel.find(id ? { _id: id } : {}).exec();
  }


  /**
   * spec 016 (broadcast fuel exchange offers) FR-005/FR-007 — every OTHER active fuel
   * company that sells `fuelType`, used both to refuse a raise with no eligible
   * recipient at all (`EXCHANGE_NO_ELIGIBLE_COMPANY`) and to resolve who the market
   * fan-out notifies (research R6). `excludingCompanyId` is optional because the
   * grade-relevance filter on a viewer's OWN incoming list (research R2) needs no
   * exclusion — a company never sees its own offers in `incoming` for an unrelated
   * reason (FR-009), not because it is excluded here.
   */
  findActiveFuelCompaniesSellingGrade(
    fuelType: FuelType,
    excludingCompanyId?: string | Types.ObjectId,
  ): Promise<CompanyDocument[]> {
    return this.companyModel
      .find({
        type: CompanyType.FUEL,
        status: CompanyStatus.ACTIVE,
        fuelPrices: { $elemMatch: { fuelType } },
        ...(excludingCompanyId ? { _id: { $ne: excludingCompanyId } } : {}),
      })
      .select('_id')
      .exec();
  }

  /**
   * spec 016 FR-010/research R13 — every FUEL company currently SUSPENDED, resolved at
   * ACTION time (never denormalised onto an offer, which a reinstated company could not
   * clear). One cheap query, never a `$lookup` inside a keyset-paginated listing.
   */
  findSuspendedFuelCompanyIds(): Promise<{ _id: Types.ObjectId }[]> {
    return this.companyModel
      .find({ type: CompanyType.FUEL, status: CompanyStatus.SUSPENDED })
      .select('_id')
      .lean()
      .exec();
  }

  async setStatus(id: string, status: CompanyStatus): Promise<CompanyDocument> {
    const company = await this.companyModel.findByIdAndUpdate(id, { status }, { new: true }).exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  async setCommercialRegisterFile(id: string, fileId: Types.ObjectId): Promise<CompanyDocument> {
    const company = await this.companyModel
      .findByIdAndUpdate(id, { commercialRegisterFileId: fileId }, { new: true })
      .exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  /**
   * Replaces the price list, carrying each grade's history forward.
   *
   * The write is deliberately NOT a blind `findByIdAndUpdate({ fuelPrices })` any
   * more: this endpoint receives the WHOLE list on every save (the dashboard sends
   * all grades back when one is edited), so a naive overwrite would stamp every
   * grade as "just changed" each time any single one was touched — turning "آخر
   * تحديث" into "when someone last opened the form" and making every change
   * percentage 0.00%. History advances per grade, and only where the number
   * actually moved.
   *
   * Read-modify-write on the loaded document rather than an atomic update: the
   * previous value has to be read to be preserved, and concurrent edits to one
   * company's prices are a two-administrators-one-form case the platform does not
   * otherwise guard (`setPricingConfig` above has the same shape).
   */
  async setFuelPrices(
    id: string,
    fuelPrices: { fuelType: FuelType; basePricePerLiter: number }[],
  ): Promise<CompanyDocument> {
    const existing = await this.companyModel.findById(id).select('fuelPrices').lean().exec();
    if (!existing) {
      throw new NotFoundException('Company not found');
    }
    const before = new Map((existing.fuelPrices ?? []).map((p) => [p.fuelType, p]));
    const now = new Date();

    const next = fuelPrices.map((incoming) => {
      const prior = before.get(incoming.fuelType);
      // A grade priced for the FIRST time is not a change — there is nothing it
      // changed from, so it gets no previous value and no timestamp.
      if (!prior) return { ...incoming };
      // Unchanged: keep whatever history it already had, untouched.
      if (prior.basePricePerLiter === incoming.basePricePerLiter) {
        return {
          ...incoming,
          previousPricePerLiter: prior.previousPricePerLiter,
          priceChangedAt: prior.priceChangedAt,
        };
      }
      return {
        ...incoming,
        previousPricePerLiter: prior.basePricePerLiter,
        priceChangedAt: now,
      };
    });

    const company = await this.companyModel
      .findByIdAndUpdate(id, { fuelPrices: next }, { new: true })
      .exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  /**
   * Active transporters of `fuelCompanyId` whose `servedRegions` include `regionCode`
   * (spec 004 FR-014/FR-016).
   *
   * Lives here, not in `RoutingService` where it began, because TWO things now depend
   * on it: routing an approved order, and pricing the delivery before the client ever
   * confirms. If those two ever answered from different rules, a client could be quoted
   * one transporter's rate and have the order hauled by another — the exact failure the
   * quote-time refusal exists to prevent. `RoutingService` delegates here.
   */
  findServingTransporters(
    fuelCompanyId: string | Types.ObjectId,
    regionCode: RegionCode,
  ): Promise<CompanyDocument[]> {
    return this.companyModel
      .find({
        type: CompanyType.TRANSPORT,
        parentFuelCompanyId: fuelCompanyId,
        status: CompanyStatus.ACTIVE,
        servedRegions: regionCode,
      })
      .exec();
  }

  /** `[]` when the transporter has priced no area yet — never a fabricated default. */
  async getDeliveryRates(companyId: string | Types.ObjectId): Promise<DeliveryRate[]> {
    const company = await this.companyModel
      .findById(companyId)
      .select('deliveryRates')
      .lean()
      .exec();
    return company?.deliveryRates ?? [];
  }

  /**
   * Replaces a TRANSPORT company's whole rate set, carrying `updatedAt` forward per
   * area for the ones that did not move — the same discipline `setFuelPrices` above
   * applies, and for the same reason: the client sends the whole list back when one
   * area is edited, so a blind overwrite would restamp every area on every save.
   */
  async setDeliveryRates(
    id: string,
    rates: Omit<DeliveryRate, 'updatedAt'>[],
  ): Promise<CompanyDocument> {
    const existing = await this.companyModel
      .findById(id)
      .select('deliveryRates type')
      .lean()
      .exec();
    if (!existing) {
      throw new NotFoundException('Company not found');
    }
    // A FUEL company hauls nothing itself; its own delivery charge lives in
    // `pricingConfig`. Refused here rather than silently stored on a document
    // nothing would ever read it from.
    if (existing.type !== CompanyType.TRANSPORT) {
      throw new BadRequestException('Only a Transportation Company has delivery rates');
    }

    const keyOf = (r: { regionCode: string; governorateCode?: string }) =>
      `${r.regionCode}:${r.governorateCode ?? '*'}`;
    const before = new Map((existing.deliveryRates ?? []).map((r) => [keyOf(r), r]));
    const now = new Date();

    const next = rates.map((incoming) => {
      const prior = before.get(keyOf(incoming));
      const unchanged =
        prior && prior.pricePerKm === incoming.pricePerKm && prior.minPrice === incoming.minPrice;
      return { ...incoming, updatedAt: unchanged ? prior.updatedAt : now };
    });

    const company = await this.companyModel
      .findByIdAndUpdate(id, { deliveryRates: next }, { new: true })
      .exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  /**
   * Creates a Transportation Company under `fuelCompanyId`, with its own
   * `TRANSPORT_COMPANY_ADMIN` admin (spec 004 US2). No `servedRegions` at
   * creation — assigning them is a deliberate, separate step
   * (`assignRegions`), never implicit.
   */
  async createTransportCompany(
    fuelCompanyId: string,
    data: Omit<Partial<Company>, 'type' | 'parentFuelCompanyId'>,
    session?: ClientSession,
  ): Promise<CompanyDocument> {
    try {
      const [company] = await this.companyModel.create(
        [
          {
            ...data,
            type: CompanyType.TRANSPORT,
            parentFuelCompanyId: new Types.ObjectId(fuelCompanyId),
            servedRegions: [],
          },
        ],
        { session },
      );
      return company;
    } catch (error) {
      throw CompaniesService.asConflict(error);
    }
  }

  /**
   * spec 013 (fuel company admin dashboard) FR-033, T086a — genuine platform addition,
   * found during analysis: `createTransportCompany` (create) existed with no listing
   * counterpart at all. A fuel company admin could onboard a transporter and never see it
   * again through any endpoint. `Company` carries no isolation marker (it is the tenant
   * root), so this method is the enforcement point, mirroring `assertCompanyAccess`'s own
   * ownership check rather than trusting a caller-supplied filter.
   */
  findTransporters(fuelCompanyId: string): Promise<CompanyDocument[]> {
    return this.companyModel
      .find({ type: CompanyType.TRANSPORT, parentFuelCompanyId: new Types.ObjectId(fuelCompanyId) })
      .exec();
  }

  /**
   * Replaces (never merges) a Transportation Company's served regions
   * (spec 004 FR-014). `fuelCompanyId` is whoever is *acting* — this throws
   * if `transportCompanyId` doesn't genuinely belong to them, the same
   * ownership guarantee `assertCompanyAccess` gives read paths, applied here
   * to a write. `Company` isn't tenant-scoped by the Mongoose plugin, so
   * this check is the only thing standing between "my transporter" and "any
   * transporter, from any Fuel Company."
   */
  async assignRegions(
    fuelCompanyId: string,
    transportCompanyId: string,
    regionCodes: RegionCode[],
  ): Promise<CompanyDocument> {
    const transporter = await this.companyModel.findById(transportCompanyId).exec();
    if (!transporter || transporter.type !== CompanyType.TRANSPORT) {
      throw new NotFoundException('Transportation company not found');
    }
    if (transporter.parentFuelCompanyId?.toString() !== fuelCompanyId) {
      // Indistinguishable from not-found, matching FR-002's cross-tenant rule
      // — a Fuel Company must never learn that a transporter id exists at
      // all if it belongs to someone else.
      throw new NotFoundException('Transportation company not found');
    }
    transporter.servedRegions = regionCodes;
    return transporter.save();
  }

  /**
   * spec 013 FR-036, T086a — the FUEL-type counterpart to `assignRegions`. Access is
   * enforced by the controller's `assertCompanyAccess` (own company only), so this method
   * trusts `id` the way `setFuelPrices`/`setPricingConfig` already do.
   */
  async setCoveredRegions(id: string, regionCodes: RegionCode[]): Promise<CompanyDocument> {
    const company = await this.companyModel
      .findByIdAndUpdate(id, { coveredRegions: regionCodes }, { new: true })
      .exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  // spec 013 T140/FR-062a — SUPER_ADMIN only (enforced by the controller's `@Roles`, not
  // `assertCompanyAccess` — a company must never set or change its own).
  async setCommissionCeiling(id: string, commissionCeiling: number): Promise<CompanyDocument> {
    const company = await this.companyModel
      .findByIdAndUpdate(id, { commissionCeiling }, { new: true })
      .exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }
}
