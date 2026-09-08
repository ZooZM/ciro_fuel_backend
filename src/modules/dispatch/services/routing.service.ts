import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Company, CompanyDocument } from '../../companies/schemas/company.schema';
import { CompanyType } from '../../../common/enums/company-type.enum';
import { CompanyStatus } from '../../../common/enums/company-status.enum';
import { RegionCode } from '../../../common/enums/region.enum';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { OrderDocument } from '../../orders/schemas/order.schema';
import { OrderStateService, TransitionActor } from '../../orders/services/order-state.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../../common/enums/notification-type.enum';
import { User, UserDocument } from '../../users/schemas/user.schema';
import { UserRole } from '../../../common/enums/user-role.enum';
import { InvoicesService } from '../../invoices/invoices.service';
import { CompaniesService } from '../../companies/companies.service';

/**
 * Resolves which Transportation Company(ies) serve a client's region, within
 * one Fuel Company (spec 004 FR-014), and owns the APPROVED ->
 * AWAITING_ROUTING | ROUTED_TO_TRANSPORT transition that follows. Routing is
 * always resolved within the client's own Fuel Company — two Fuel Companies
 * may serve the same region without conflict, since they are isolated
 * tenants (spec Assumptions).
 */
@Injectable()
export class RoutingService {
  constructor(
    @InjectModel(Company.name) private readonly companyModel: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly orderStateService: OrderStateService,
    private readonly notificationsService: NotificationsService,
    private readonly invoicesService: InvoicesService,
    private readonly companiesService: CompaniesService,
  ) {}

  /** Active transporters of `fuelCompanyId` whose `servedRegions` include
   * `regionCode`. Empty → FR-016 (no coverage); more than one → FR-014
   * (Fuel Company must choose).
   *
   * Delegates to `CompaniesService`: `PricingService` now resolves the delivery
   * price through this same rule at quote time, and two copies of it would be two
   * places for the answer to drift. */
  findServingTransporters(
    fuelCompanyId: string | Types.ObjectId,
    regionCode: RegionCode,
  ): Promise<CompanyDocument[]> {
    return this.companiesService.findServingTransporters(fuelCompanyId, regionCode);
  }

  /**
   * Resolves and applies routing for an order already at APPROVED
   * (spec 004 FR-014/FR-015/FR-016):
   * - exactly one serving transporter -> ROUTED_TO_TRANSPORT automatically;
   * - none -> AWAITING_ROUTING, Fuel Company notified (FR-016);
   * - more than one and none `chosenTransportCompanyId` given ->
   *   AWAITING_ROUTING too (a holding state for manual resolution — the
   *   same state, whether the reason is zero candidates or an unresolved
   *   choice among several), Fuel Company notified with the candidate list
   *   so their next call can supply the choice;
   * - more than one and a valid `chosenTransportCompanyId` given ->
   *   ROUTED_TO_TRANSPORT with that choice (FR-014).
   *
   * Also used to resolve an already-AWAITING_ROUTING order once an admin
   * supplies (or a later region assignment makes possible) a transporter —
   * `from` distinguishes the two entry points at the transition layer.
   */
  async routeOrder(
    order: OrderDocument,
    actor: TransitionActor,
    from: OrderStatus.APPROVED | OrderStatus.AWAITING_ROUTING,
    chosenTransportCompanyId?: string,
  ): Promise<{ order: OrderDocument; candidates: CompanyDocument[] }> {
    const client = await this.userModel.findById(order.clientId).exec();
    const regionCode = client?.station?.regionCode;
    if (!regionCode) {
      throw new BadRequestException('Client has no station region on file — cannot route');
    }

    const candidates = await this.findServingTransporters(order.fuelCompanyId, regionCode);

    // An explicit choice is ALWAYS validated against the real candidate
    // set, regardless of how many there are — including zero: a chosen id
    // that isn't a genuine, region-serving transporter of this Fuel
    // Company must be rejected, never silently ignored back into
    // AWAITING_ROUTING as if nothing had been chosen.
    let resolvedTransportCompanyId: string | undefined;
    if (chosenTransportCompanyId) {
      const isValidChoice = candidates.some((c) => String(c._id) === chosenTransportCompanyId);
      if (!isValidChoice) {
        throw new BadRequestException(
          'transportCompanyId is not one of the transporters serving this region',
        );
      }
      resolvedTransportCompanyId = chosenTransportCompanyId;
    } else if (candidates.length === 1) {
      resolvedTransportCompanyId = String(candidates[0]._id);
    }

    if (!resolvedTransportCompanyId) {
      const updated =
        from === OrderStatus.AWAITING_ROUTING
          ? order
          : await this.orderStateService.transition(
              order._id as Types.ObjectId,
              from,
              OrderStatus.AWAITING_ROUTING,
              actor,
            );
      await this.notifyUnroutable(updated, candidates);
      return { order: updated, candidates };
    }

    const updated = await this.orderStateService.transition(
      order._id as Types.ObjectId,
      from,
      OrderStatus.ROUTED_TO_TRANSPORT,
      actor,
      { extraSet: { transportCompanyId: new Types.ObjectId(resolvedTransportCompanyId) } },
    );
    // No-op unless this order's invoice is DEFERRED (FR-022) — its payer is
    // only known once routing resolves it, since issuance always precedes
    // routing (plan.md §4).
    await this.invoicesService.setTransportCompanyId(
      updated._id as Types.ObjectId,
      resolvedTransportCompanyId,
    );
    await this.notifyRouted(updated, resolvedTransportCompanyId);
    return { order: updated, candidates: [] };
  }

  private async notifyRouted(order: OrderDocument, transportCompanyId: string): Promise<void> {
    const admins = await this.userModel
      .find({
        companyId: transportCompanyId,
        role: UserRole.TRANSPORT_COMPANY_ADMIN,
        isActive: true,
      })
      .exec();
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          companyId: transportCompanyId,
          recipientUserId: admin._id as Types.ObjectId,
          type: NotificationType.ORDER_ROUTED_TO_TRANSPORT,
          orderId: order._id as Types.ObjectId,
        }),
      ),
    );
  }

  /** FR-016: zero or ambiguous candidates — only the Fuel Company can
   * resolve it (assign regions to a transporter, or PATCH .../route). */
  private async notifyUnroutable(
    order: OrderDocument,
    candidates: CompanyDocument[],
  ): Promise<void> {
    const admins = await this.userModel
      .find({ companyId: order.fuelCompanyId, role: UserRole.FUEL_COMPANY_ADMIN, isActive: true })
      .exec();
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notify({
          companyId: order.fuelCompanyId,
          recipientUserId: admin._id as Types.ObjectId,
          type: NotificationType.NO_DRIVER_AVAILABLE,
          orderId: order._id as Types.ObjectId,
          payload: { candidateTransportCompanyIds: candidates.map((c) => String(c._id)) },
        }),
      ),
    );
  }
}
