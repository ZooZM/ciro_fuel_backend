import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { OrdersService } from '../orders/orders.service';
import { CompaniesService } from '../companies/companies.service';
import { StationsService } from '../stations/stations.service';
import { CompanyType } from '../../common/enums/company-type.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { PeriodFigureBasis } from '../../common/enums/period-figure-basis.enum';
import { OrderStatusBucket } from '../../common/constants/order-status-buckets';
import { PlatformOverviewDto } from './dto/platform-overview.dto';
import { TransportCompanyVolumeDto } from './dto/transport-company-volume.dto';

/**
 * spec 017 (operator dashboard) US1 — the platform's own figures.
 *
 * **No new isolation mechanism is used and none is needed** (research R1). Both
 * scoping plugins already return early for `SUPER_ADMIN` in their `find`,
 * `save`, `insertMany` *and* `aggregate` hooks, so every count and aggregation
 * below is genuinely platform-wide when reached through a `SUPER_ADMIN`-gated
 * route — and correctly scoped if it ever were not. There is no `runUnscoped`
 * here, no second connection and no plugin edit; the spec's Risks section
 * warned this would be "the first cross-company aggregate" and could silently
 * inherit company scoping, and verification showed the bypass already covers
 * aggregates.
 */
@Injectable()
export class PlatformOverviewService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly ordersService: OrdersService,
    private readonly companiesService: CompaniesService,
    private readonly stationsService: StationsService,
  ) {}

  /**
   * FR-001/FR-002/FR-006 — every figure on the operator's home screen.
   *
   * The three period figures are computed on **two different bases**, which is
   * the single most consequential decision in this file (FR-001a, research R6):
   *
   * - `orderCount` counts orders **raised** in the period — `createdAt`, every
   *   state.
   * - `orderValue` and `litresMoved` count **delivered** orders only —
   *   `deliveredAt`, `status: DELIVERED`.
   *
   * An earlier draft extended the spec's delivered-only Assumption to the order
   * count as well. That is wrong with no visible error: a delivered-only count
   * IS the `COMPLETED` bucket, so the other five buckets of FR-006 would be
   * structurally zero and the six-segment chart could never sum to the card
   * above it. Both bases are named in the response rather than left to be
   * inferred, because two figures under one date range answering on different
   * bases otherwise reads as a bug in one of them.
   */
  async getOverview(from: Date, to: Date, isDefault: boolean): Promise<PlatformOverviewDto> {
    const [deliveredTotals, fuelCompanies, transportCompanies, stations, orderSummary] =
      await Promise.all([
        this.sumDeliveredTotals(from, to),
        this.companiesService.countByType(CompanyType.FUEL),
        this.companiesService.countByType(CompanyType.TRANSPORT),
        // `countForPlatform`, not `countForCompany` — the same query, but a name
        // that says what it does at THIS call site (research R6).
        this.stationsService.countForPlatform(),
        // Delegated, never counted a second time: the home chart and the orders
        // screen read one computation, so they cannot drift apart about what
        // "in progress" means, and `orderCount` below is the same figure the six
        // buckets sum to by construction rather than by coincidence.
        this.ordersService.getPlatformSummary(from, to),
      ]);

    return {
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        isDefault,
        orderCount: orderSummary.total,
        orderValue: deliveredTotals.orderValue,
        litresMoved: deliveredTotals.litresMoved,
        basis: {
          orderCount: PeriodFigureBasis.RAISED_IN_PERIOD,
          orderValue: PeriodFigureBasis.DELIVERED_IN_PERIOD,
          litresMoved: PeriodFigureBasis.DELIVERED_IN_PERIOD,
        },
      },
      pointInTime: { fuelCompanies, transportCompanies, stations },
      breakdown: {
        byCompanyType: [
          { type: CompanyType.FUEL, count: fuelCompanies },
          { type: CompanyType.TRANSPORT, count: transportCompanies },
        ],
        // All six buckets, in the enum's own order, including zeros — a chart
        // segment must be able to tell "none" from "not computed" (FR-008).
        byOrderBucket: Object.values(OrderStatusBucket).map((bucket) => ({
          bucket,
          count: orderSummary.buckets[bucket],
        })),
      },
    };
  }

  /**
   * Trading value and litres moved, over `DELIVERED` orders bounded by
   * `deliveredAt`. One `$group`, never a fetch-and-reduce: this is the
   * platform's whole order collection, and the only bounded way to ask it is to
   * let the database do the summing.
   *
   * `finalPrice` falls back to `estimatedPrice` — `finalPrice` is written at
   * approval, so every delivered order has one, but an order that somehow
   * reached `DELIVERED` without one must contribute its quoted value rather
   * than silently contributing zero and understating the platform's turnover.
   *
   * An empty period returns zeros, never absent fields (FR-008): `$group`
   * yields no document at all when nothing matches, so the zeros are supplied
   * here rather than left to the caller to guess at.
   */
  private async sumDeliveredTotals(
    from: Date,
    to: Date,
  ): Promise<{ orderValue: number; litresMoved: number }> {
    const [totals] = await this.orderModel
      .aggregate<{ orderValue: number; litresMoved: number }>([
        {
          $match: {
            status: OrderStatus.DELIVERED,
            deliveredAt: { $gte: from, $lte: to },
          },
        },
        {
          $group: {
            _id: null,
            orderValue: { $sum: { $ifNull: ['$finalPrice', '$estimatedPrice'] } },
            litresMoved: { $sum: '$quantityLiters' },
          },
        },
      ])
      .exec();

    return {
      orderValue: totals?.orderValue ?? 0,
      litresMoved: totals?.litresMoved ?? 0,
    };
  }

  /**
   * spec 017 T068b/FR-026a/FR-026b — how many orders were routed to each of a
   * page of transport companies in the period.
   *
   * **One aggregate for the whole page**, never one query per company. The
   * transport list renders a page of rows at a time and the volume column sits
   * on every one of them; a figure per row would be an N+1 over the platform's
   * whole order collection on a screen the operator opens constantly.
   *
   * Counts orders **raised** in the period — the same basis as the overview's
   * `orderCount` (FR-026a). Two figures the operator reads minutes apart, on
   * two screens, under the same date range, must be counting the same thing.
   *
   * A transporter no order has ever been routed to returns `orderCount: 0`
   * rather than being omitted. An omitted row renders as a blank cell, which is
   * indistinguishable from a column that failed to load; a zero is the answer.
   */
  async getTransportCompanyVolumes(
    companyIds: string[],
    from: Date,
    to: Date,
  ): Promise<TransportCompanyVolumeDto[]> {
    const valid = companyIds.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return [];
    const objectIds = valid.map((id) => new Types.ObjectId(id));

    const rows = await this.orderModel
      .aggregate<{ _id: Types.ObjectId; orderCount: number }>([
        {
          $match: {
            transportCompanyId: { $in: objectIds },
            createdAt: { $gte: from, $lte: to },
          },
        },
        { $group: { _id: '$transportCompanyId', orderCount: { $sum: 1 } } },
      ])
      .exec();

    const counts = new Map(rows.map((row) => [String(row._id), row.orderCount]));
    // Driven by the REQUESTED ids, not by the aggregate's result, so every
    // company asked about gets a row back.
    return valid.map((companyId) => ({
      companyId,
      orderCount: counts.get(companyId) ?? 0,
    }));
  }
}
