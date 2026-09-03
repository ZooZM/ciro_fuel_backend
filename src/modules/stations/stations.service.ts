import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Station, StationDocument } from './schemas/station.schema';
import { ErrorCode } from '../../common/enums/error-code.enum';

/**
 * Every client-facing read/write here adds `clientId` on top of whatever
 * the tenant plugin already injects (`companyId`, automatic — see
 * `tenant-scope.plugin.ts`). Company scoping alone is NOT client scoping:
 * two clients routinely share a fuel company, so a query filtered only by
 * `companyId` would let one client reach another's stations. This is the
 * single likeliest place in feature 005 to introduce a cross-client leak
 * (data-model.md), so every method below states the extra filter explicitly
 * rather than leaving it implicit.
 */
@Injectable()
export class StationsService {
  constructor(@InjectModel(Station.name) private readonly stationModel: Model<StationDocument>) {}

  /** The caller's own active stations, default first (FR-036a). */
  findForClient(clientId: string): Promise<StationDocument[]> {
    return this.stationModel
      .find({ clientId: new Types.ObjectId(clientId), isActive: true })
      .sort({ isDefault: -1, createdAt: 1 })
      .exec();
  }

  /**
   * spec 013 (fuel company admin dashboard) FR-025, R5 — every station belonging to the
   * acting fuel company, across ALL its owners, not one owner at a time. Deliberately no
   * explicit filter: `Station` is `markTenantScoped`, so the plugin already injects
   * `{ companyId }` for the acting `FUEL_COMPANY_ADMIN` — writing one here would be a
   * second, redundant filter this method does not need and the plan explicitly warns
   * against re-deriving.
   */
  // spec 013 T238 (US13): `companyId` is safe to accept unconditionally — the
  // tenant-scope plugin's own `.where({companyId})` overwrites this key for a
  // FUEL_COMPANY_ADMIN caller regardless of what is passed, so it is only ever
  // load-bearing for SUPER_ADMIN, who bypasses the plugin and otherwise sees every
  // company's stations mixed together with no way to narrow to one.
  findAllForCompany(companyId?: string): Promise<StationDocument[]> {
    return this.stationModel
      .find(companyId ? { companyId } : {})
      .sort({ createdAt: -1 })
      .exec();
  }

  // spec 013 T111/T113/FR-046 — the dashboard summary's station count. A `countDocuments`
  // counterpart to `findAllForCompany` above rather than `.length` on the full list, same
  // tenant-scoping note applies (no explicit filter needed).
  countForCompany(): Promise<number> {
    return this.stationModel.countDocuments({}).exec();
  }

  /**
   * A CLIENT may write `isFavourite` and nothing else (FR-036b) — enforced
   * by the DTO at the controller boundary, reasserted here by only ever
   * setting this one field regardless of what's passed in.
   */
  async setFavourite(
    stationId: string,
    clientId: string,
    isFavourite: boolean,
  ): Promise<StationDocument> {
    const station = await this.stationModel
      .findOneAndUpdate(
        { _id: stationId, clientId: new Types.ObjectId(clientId) },
        { $set: { isFavourite } },
        { new: true },
      )
      .exec();
    if (!station) {
      // 404, never 403 — cross-boundary ids don't reveal existence (contract convention).
      throw new NotFoundException('Station not found');
    }
    return station;
  }

  /** FUEL_COMPANY_ADMIN — every active station registered to one of their clients. */
  findForClientAsAdmin(clientId: string): Promise<StationDocument[]> {
    // No isActive filter here: an admin managing a client's stations needs
    // to see (and potentially reactivate) withdrawn ones too.
    return this.stationModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .sort({ isDefault: -1, createdAt: 1 })
      .exec();
  }

  async create(
    clientId: string,
    companyId: string,
    dto: {
      name?: string;
      regionCode: Station['regionCode'];
      governorateCode: Station['governorateCode'];
      location: Station['location'];
      addressText?: string;
    },
  ): Promise<StationDocument> {
    const existingCount = await this.stationModel
      .countDocuments({ clientId: new Types.ObjectId(clientId), isActive: true })
      .exec();
    return this.stationModel.create({
      clientId: new Types.ObjectId(clientId),
      companyId: new Types.ObjectId(companyId),
      name: dto.name,
      regionCode: dto.regionCode,
      governorateCode: dto.governorateCode,
      location: dto.location,
      addressText: dto.addressText ?? '',
      // The client's first station is their default automatically — no
      // separate admin step, and satisfies "exactly one default" from creation.
      isDefault: existingCount === 0,
    });
  }

  /**
   * FUEL_COMPANY_ADMIN (spec 005 T108) — the only real caller (FR-036b: a
   * CLIENT never reaches this). Identified by station id alone, not a
   * clientId filter — an admin may edit any of their own company's clients'
   * stations, and the tenant-scope plugin already confines `stationModel`
   * to the admin's own `companyId` for every query here.
   */
  async update(
    stationId: string,
    dto: Partial<{
      name: string;
      regionCode: Station['regionCode'];
      governorateCode: Station['governorateCode'];
      location: Station['location'];
      addressText: string;
    }>,
  ): Promise<StationDocument> {
    const station = await this.stationModel
      .findOneAndUpdate({ _id: stationId }, { $set: dto }, { new: true })
      .exec();
    if (!station) {
      throw new NotFoundException('Station not found');
    }
    return station;
  }

  /**
   * Soft delete (FR-036c — a withdrawn station stays readable through any
   * order that referenced it). FUEL_COMPANY_ADMIN-only, identified by
   * station id alone (see {@link update}'s doc comment). Refuses to remove
   * a client's last active station (FR-017/quickstart — a client with none
   * cannot order), and promotes the next-oldest active station to default
   * when the default itself is removed, so the "exactly one default"
   * invariant never lapses.
   */
  async remove(stationId: string): Promise<void> {
    const target = await this.stationModel.findOne({ _id: stationId, isActive: true }).exec();
    if (!target) {
      throw new NotFoundException('Station not found');
    }

    const activeCount = await this.stationModel
      .countDocuments({ clientId: target.clientId, isActive: true })
      .exec();
    if (activeCount <= 1) {
      // Object body, not a bare string (T106) — HttpExceptionFilter only
      // reads `error` off an object-shaped body; a string body puts the
      // text in `message` and falls back to the exception's class name for
      // `error`, so the mobile app's ErrorCodes.lastStation check would
      // never actually match.
      throw new ConflictException({
        error: ErrorCode.LAST_STATION,
        message: 'Cannot remove your only active station',
      });
    }

    await this.stationModel
      .updateOne({ _id: stationId }, { $set: { isActive: false, isDefault: false } })
      .exec();

    if (target.isDefault) {
      const next = await this.stationModel
        .findOne({ clientId: target.clientId, isActive: true, _id: { $ne: stationId } })
        .sort({ createdAt: 1 })
        .exec();
      if (next) {
        await this.stationModel.updateOne({ _id: next._id }, { $set: { isDefault: true } }).exec();
      }
    }
  }

  /**
   * A single active station, verified to belong to `clientId` — the check
   * order creation and quoting both need (contract §3: a `stationId` not
   * the caller's own is a 404, never a 403).
   */
  async findOwnedByClient(stationId: string, clientId: string): Promise<StationDocument> {
    const station = await this.stationModel
      .findOne({ _id: stationId, clientId: new Types.ObjectId(clientId), isActive: true })
      .exec();
    if (!station) {
      throw new NotFoundException('Station not found');
    }
    return station;
  }

  /** The client's current default station, or `null` if none is set (pre-migration edge case). */
  findDefaultForClient(clientId: string): Promise<StationDocument | null> {
    return this.stationModel
      .findOne({ clientId: new Types.ObjectId(clientId), isDefault: true, isActive: true })
      .exec();
  }

  /**
   * Resolves an order's `stationId` reference regardless of the station's
   * `isActive` state (FR-036c: a withdrawn station stays readable through
   * any order that referenced it). No `clientId` filter here — the caller
   * (an order read) has already authorized access to the order itself; the
   * tenant plugin still scopes by company. `undefined` in, `null` out —
   * orders predating the station migration have no `stationId` at all.
   */
  findByIdIncludingInactive(stationId: string | undefined): Promise<StationDocument | null> {
    if (!stationId) return Promise.resolve(null);
    return this.stationModel.findById(stationId).exec();
  }

  /**
   * The same read for a whole page of orders, as one query.
   *
   * A page routinely references the same station repeatedly — a client
   * ordering to one depot all week — so this de-duplicates before querying
   * and returns a map to look up by id. Doing it per order would issue N
   * round trips to render one list.
   */
  async findManyIncludingInactive(
    stationIds: ReadonlyArray<string | undefined>,
  ): Promise<Map<string, StationDocument>> {
    const ids = [...new Set(stationIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return new Map();
    const stations = await this.stationModel.find({ _id: { $in: ids } }).exec();
    return new Map(stations.map((station) => [String(station._id), station]));
  }
}
