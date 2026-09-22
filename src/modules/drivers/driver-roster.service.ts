import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { Company, CompanyDocument } from '../companies/schemas/company.schema';
import { Truck, TruckDocument } from '../trucks/schemas/truck.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { DutyState } from '../../common/enums/duty-state.enum';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { CursorSortField } from '../../common/pagination/cursor.util';
import { DriverRosterRowDto } from './dto/driver-roster.dto';

/**
 * **`createdAt`/`_id`, never `lastSeenAt` or `isOnline`.**
 *
 * Every driver document has both of these fields; `lastSeenAt` exists only on a
 * driver who has connected at least once. Sorting a keyset page on a field some
 * documents lack silently drops those documents — exactly how feature 010's
 * dispatch listing lost every never-located driver to `$geoNear`. FR-040 makes
 * the never-connected driver's PRESENCE a requirement, so the sort key is the
 * thing that has to be right.
 */
const DRIVER_ROSTER_SORT_KEYS: CursorSortField[] = [
  { field: 'createdAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];

export interface DriverRosterFilter {
  isActive?: boolean;
  dutyState?: DutyState;
  cursor?: string;
}

/**
 * spec 017 (operator dashboard) US5 — the platform's driver roster.
 *
 * Its own route rather than a filter on `GET /users?role=DRIVER`, which returns
 * an unbounded array with no cursor, no employer and no truck. More
 * importantly, it is its own SHAPE: `DriverRosterRowDto` is the privacy
 * boundary (FR-043, FR-044), and widening an existing endpoint that returns raw
 * `User` documents would have handed the operator `location`, `lastSeenAt`,
 * `lastMovedAt` and `activeOrderId` in the same response.
 */
@Injectable()
export class DriverRosterService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Company.name) private readonly companyModel: Model<CompanyDocument>,
    @InjectModel(Truck.name) private readonly truckModel: Model<TruckDocument>,
  ) {}

  async list(filter: DriverRosterFilter): Promise<PaginatedResponse<DriverRosterRowDto>> {
    const query: FilterQuery<UserDocument> = { role: UserRole.DRIVER };
    if (filter.isActive !== undefined) {
      query.isActive = filter.isActive;
    }
    if (filter.dutyState) {
      Object.assign(query, dutyStateFilter(filter.dutyState));
    }

    const page = await paginate(this.userModel, query, DRIVER_ROSTER_SORT_KEYS, filter.cursor);

    const driverIds = page.items.map((driver) => String(driver._id));
    // Two batched lookups for the whole page, never one per row.
    const [companies, trucks] = await Promise.all([
      this.resolveCompanyNames(page.items),
      this.resolveLastOperatedTrucks(driverIds),
    ]);

    return {
      items: page.items.map((driver) => {
        const companyId = driver.companyId ? String(driver.companyId) : null;
        return {
          driverId: String(driver._id),
          fullName: driver.fullName,
          phone: driver.phone,
          isActive: driver.isActive ?? false,
          dutyState: dutyStateOf(driver),
          transportCompany:
            companyId && companies.has(companyId)
              ? { id: companyId, name: companies.get(companyId)! }
              : null,
          lastOperatedTruck: trucks.get(String(driver._id)) ?? null,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  /** One query for the whole page's employers (T085). */
  private async resolveCompanyNames(drivers: UserDocument[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        drivers
          .map((driver) => (driver.companyId ? String(driver.companyId) : null))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (ids.length === 0) return new Map();
    const companies = await this.companyModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select({ name: 1 })
      .exec();
    return new Map(companies.map((company) => [String(company._id), company.name]));
  }

  /**
   * T084/FR-039a/FR-039b/FR-044a — the most recently operated truck for a whole
   * page of drivers, in **one** aggregate.
   *
   * **`DispatchService.getSuggestedTruck` is the right query and the wrong
   * function to call** (research R8). It runs this same lookup and then
   * SUPPRESSES the answer when the truck is currently unavailable, because it
   * is a pick-list suggestion and suggesting a busy truck would be useless.
   * The roster states a historical fact, so that suppression would make a
   * driver whose truck is on a job right now read as "never driven" — collapsing
   * the exact distinction FR-039b requires. The query and its existing
   * `{ driverId, truckId, createdAt }` partial index are reused; the function is
   * not.
   *
   * The `$group` projects **`truckId` alone** (FR-044a). Nothing about the
   * orders this was derived from — their count, dates, customers or routes —
   * can reach the response, because nothing else is ever read out of them. That
   * is a structural guarantee rather than a discipline one: there is no field
   * here for a later change to start forwarding.
   */
  private async resolveLastOperatedTrucks(
    driverIds: string[],
  ): Promise<Map<string, { id: string; plateNumber: string }>> {
    if (driverIds.length === 0) return new Map();
    const objectIds = driverIds.map((id) => new Types.ObjectId(id));

    const rows = await this.orderModel
      .aggregate<{ _id: Types.ObjectId; truckId: Types.ObjectId }>([
        {
          $match: {
            driverId: { $in: objectIds },
            truckId: { $exists: true },
          },
        },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$driverId', truckId: { $first: '$truckId' } } },
        // Nothing but the driver and the truck leaves this pipeline.
        { $project: { _id: 1, truckId: 1 } },
      ])
      .exec();

    if (rows.length === 0) return new Map();

    const trucks = await this.truckModel
      .find({ _id: { $in: rows.map((row) => row.truckId) } })
      .select({ plateNumber: 1 })
      .exec();
    const plates = new Map(trucks.map((truck) => [String(truck._id), truck.plateNumber]));

    const byDriver = new Map<string, { id: string; plateNumber: string }>();
    for (const row of rows) {
      const truckId = String(row.truckId);
      const plateNumber = plates.get(truckId);
      // A truck id on an order with no matching Truck document is a
      // data-integrity fault, not a "never driven" driver. Skipping it here
      // would report `null` and say the opposite of the truth; the row is
      // omitted from this map so the caller's `?? null` never claims a driver
      // who HAS driven never has. (An unresolvable identity being a 500 rather
      // than a null is the contract's own rule — in practice `Truck` documents
      // are never deleted, only withdrawn, so this cannot arise.)
      if (plateNumber !== undefined) {
        byDriver.set(String(row._id), { id: truckId, plateNumber });
      }
    }
    return byDriver;
  }
}

/**
 * FR-040 — three-valued, derived from two fields rather than read from one.
 *
 * `isOnline` defaults to `false`, so it alone cannot tell "has never connected"
 * from "is off duty". `lastSeenAt` is the discriminator: it is written the first
 * time a driver connects and never cleared.
 */
function dutyStateOf(driver: UserDocument): DutyState {
  if (!driver.lastSeenAt) return DutyState.UNKNOWN;
  return driver.isOnline ? DutyState.ON_DUTY : DutyState.OFF_DUTY;
}

/** The query form of {@link dutyStateOf}, so the filter and the reported value cannot disagree. */
function dutyStateFilter(state: DutyState): FilterQuery<UserDocument> {
  switch (state) {
    case DutyState.UNKNOWN:
      return { lastSeenAt: { $exists: false } };
    case DutyState.ON_DUTY:
      return { lastSeenAt: { $exists: true }, isOnline: true };
    case DutyState.OFF_DUTY:
      return { lastSeenAt: { $exists: true }, isOnline: { $ne: true } };
  }
}
