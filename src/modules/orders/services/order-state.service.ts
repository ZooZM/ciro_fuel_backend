import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../schemas/order.schema';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { UserRole } from '../../../common/enums/user-role.enum';
import { RealtimeGatewayService } from '../../../common/realtime/realtime-gateway.service';

interface TransitionRule {
  to: OrderStatus;
  // true: this edge is ONLY legal when the caller passes manualOverride (e.g.
  // IN_TRANSIT -> DELIVERED, the force-complete emergency skip). Edges without
  // this flag may still be reached WITH manualOverride (e.g. UNLOADING ->
  // DELIVERED via the normal OTP flow OR an admin force-complete).
  requiresManualOverride?: boolean;
}

// Mirrors data-model.md's state machine diagram (FR-006/FR-025), extended by
// spec 004 FR-014/FR-016 (routing) and FR-020a/FR-020b (billing, US5):
//
// - APPROVED branches into AWAITING_ROUTING (no transporter serves the
//   client's region), ROUTED_TO_TRANSPORT (one resolved) — both immediately,
//   for DEFERRED/CREDIT orders — OR, for DIRECT orders, PENDING_PAYMENT
//   first: FR-020a forbids routing a direct order before its invoice is
//   settled, so DIRECT reaches routing only via PENDING_PAYMENT -> APPROVED
//   (settlement) -> a second pass through this same APPROVED branch.
// - PENDING_PAYMENT -> APPROVED therefore serves TWO distinct events that
//   share one edge: a successful settlement (proceeds to routing next) and a
//   timeout (paymentTimeoutCount increments, redispatch re-opens payment).
// - spec 008 FR-046a/R3: ASSIGNED_TO_DRIVER no longer auto-advances to
//   IN_TRANSIT — that edge is REMOVED. Assignment now stops at
//   ASSIGNED_TO_DRIVER pending departure verification (or an operator
//   override), which lands the order on the new LOADING status; loading
//   confirmation (or override) is what reaches IN_TRANSIT. IN_TRANSIT
//   therefore narrows to "loaded and travelling to the customer".
const TRANSITIONS: Record<OrderStatus, TransitionRule[]> = {
  [OrderStatus.PENDING_APPROVAL]: [
    { to: OrderStatus.APPROVED },
    { to: OrderStatus.REJECTED },
    { to: OrderStatus.CANCELLED },
  ],
  [OrderStatus.APPROVED]: [
    { to: OrderStatus.PENDING_PAYMENT }, // DIRECT invoice just issued (FR-020a)
    { to: OrderStatus.AWAITING_ROUTING },
    { to: OrderStatus.ROUTED_TO_TRANSPORT },
    { to: OrderStatus.CANCELLED },
  ],
  [OrderStatus.AWAITING_ROUTING]: [
    { to: OrderStatus.ROUTED_TO_TRANSPORT }, // admin manually resolves a transporter later
    { to: OrderStatus.CANCELLED },
  ],
  [OrderStatus.ROUTED_TO_TRANSPORT]: [
    { to: OrderStatus.ASSIGNED_TO_DRIVER },
    // Routing is what makes the total knowable — the transport company that
    // was just chosen is the one that prices the haul — so the order goes back
    // to the station owner to settle before any driver is assigned. This edge
    // and its return below replace the old APPROVED -> PENDING_PAYMENT one,
    // which gated payment on a total that did not yet include the haul.
    { to: OrderStatus.PENDING_PAYMENT },
    { to: OrderStatus.CANCELLED },
  ],
  // spec 008: LOADING replaces the direct edge to IN_TRANSIT — reached by a
  // successful departure verification or an operator override, never by
  // assignment itself (FR-046a).
  [OrderStatus.ASSIGNED_TO_DRIVER]: [{ to: OrderStatus.LOADING }, { to: OrderStatus.CANCELLED }],
  [OrderStatus.PENDING_PAYMENT]: [
    // The station owner settled (DIRECT) or accepted (DEFERRED/CREDIT): the
    // order returns to the transporter it was already routed to, and the
    // driver assignment that was waiting behind it can proceed.
    { to: OrderStatus.ROUTED_TO_TRANSPORT },
    // The payment-deadline timeout (FR-015a) — redispatch re-opens the window
    // from APPROVED. Routing is NOT undone: `transportCompanyId` and the
    // priced breakdown both survive, so re-opening asks the same station owner
    // to settle the same total rather than re-running the choice.
    { to: OrderStatus.APPROVED },
    { to: OrderStatus.CANCELLED }, // admin cancel OR station owner refuses the total
  ],
  // spec 008 FR-046d/FR-046e: loading confirmation (or override) reaches
  // IN_TRANSIT; cancellation stays reachable while the truck is still at the
  // depot; DELIVERED is force-complete only, mirroring IN_TRANSIT's own edge.
  [OrderStatus.LOADING]: [
    { to: OrderStatus.IN_TRANSIT },
    { to: OrderStatus.CANCELLED },
    { to: OrderStatus.DELIVERED, requiresManualOverride: true },
  ],
  [OrderStatus.IN_TRANSIT]: [
    { to: OrderStatus.UNLOADING },
    { to: OrderStatus.DELIVERED, requiresManualOverride: true }, // force-complete only (FR-025)
  ],
  [OrderStatus.UNLOADING]: [{ to: OrderStatus.DELIVERED }],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.REJECTED]: [],
  [OrderStatus.CANCELLED]: [],
};

export interface TransitionActor {
  actorId: string;
  actorRole: UserRole;
}

export interface TransitionOptions {
  session?: ClientSession;
  manualOverride?: boolean;
  overrideReason?: string;
  /** Additional $set fields applied atomically with the status change. */
  extraSet?: Record<string, unknown>;
  /** Field names to $unset atomically with the status change. */
  extraUnset?: string[];
}

@Injectable()
export class OrderStateService {
  private readonly logger = new Logger(OrderStateService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly realtimeGateway: RealtimeGatewayService,
  ) {}

  async transition(
    orderId: string | Types.ObjectId,
    from: OrderStatus,
    to: OrderStatus,
    actor: TransitionActor,
    options: TransitionOptions = {},
  ): Promise<OrderDocument> {
    const rule = TRANSITIONS[from]?.find((r) => r.to === to);
    if (!rule) {
      throw new ConflictException(`Invalid transition from ${from} to ${to}`);
    }
    if (rule.requiresManualOverride && !options.manualOverride) {
      throw new ConflictException(
        `Transition from ${from} to ${to} requires an audited manual override`,
      );
    }

    const historyEntry = {
      from,
      to,
      actorId: new Types.ObjectId(actor.actorId),
      actorRole: actor.actorRole,
      at: new Date(),
      ...(options.manualOverride
        ? { manualOverride: true, overrideReason: options.overrideReason }
        : {}),
    };

    const updated = await this.orderModel
      .findOneAndUpdate(
        { _id: orderId, status: from },
        {
          $set: {
            status: to,
            // spec 007 FR-032/FR-033/research R7: set here, not at either
            // caller, so it is set identically whether DELIVERED is reached
            // via the normal OTP flow or an admin `forceComplete` override
            // (T071) — `updatedAt` drifts after this moment (invoice
            // issuance, payment settlement), so it cannot back a daily count.
            ...(to === OrderStatus.DELIVERED ? { deliveredAt: historyEntry.at } : {}),
            ...options.extraSet,
          },
          $push: { statusHistory: historyEntry },
          ...(options.extraUnset?.length
            ? { $unset: Object.fromEntries(options.extraUnset.map((f) => [f, ''])) }
            : {}),
        },
        { new: true, session: options.session },
      )
      .exec();

    if (updated) {
      // spec 012 FR-032/SC-007. THE record an order's history is reconstructed
      // from: every status change the platform makes passes through this one
      // method, so one record here covers all of them.
      //
      // `orderId` is a FIELD, never interpolated into the message. That is the
      // whole requirement and the single easiest thing to half-do — a message
      // reading `Order 652f… moved to LOADING` looks identical in a terminal
      // and is not retrievable by `jsonPayload.orderId`, which is how an
      // incident is actually investigated. `from`/`to`/`actorRole` are fields
      // for the same reason.
      this.logger.log(
        {
          orderId: String(orderId),
          from,
          to,
          actorRole: actor.actorRole,
          manualOverride: options.manualOverride ?? false,
        },
        'Order status transition',
      );

      // Emitted synchronously with the write rather than after commit — the
      // one edge case this misses (transaction rolls back after this point)
      // is rare and self-corrects on the watcher's next fetch; not worth the
      // complexity of deferring emission for a system this size.
      const payload = { orderId: String(orderId), from, to, at: historyEntry.at };
      this.realtimeGateway.emitToOrderRoom(String(orderId), 'order:status', payload);
      // spec 007: a DRIVER can never join the order room — TrackingGateway's
      // `order:watch` refuses UserRole.DRIVER with FORBIDDEN_ROLE, since that
      // room also carries the client's live driver-position feed. Without
      // this second emit, an order status change could never reach the
      // assigned driver by any path (research R1). Same payload, same event
      // name, so the app registers exactly one `order:status` handler
      // regardless of which room delivered it.
      if (updated.driverId) {
        this.realtimeGateway.emitToUser(String(updated.driverId), 'order:status', payload);
      }
      // The CLIENT needs the same third path, and for a closely related
      // reason. They are not BANNED from the order room like the driver is —
      // `order:watch` simply refuses it with NOT_TRACKABLE until the order
      // reaches IN_TRANSIT, because that room carries the live position feed
      // and there is no position to feed before then. The effect is the same:
      // across PENDING_APPROVAL -> PENDING_PAYMENT -> ROUTED_TO_TRANSPORT ->
      // ASSIGNED_TO_DRIVER -> LOADING the customer had no live path at all,
      // and no notification covered those stages either (the only two client
      // notifications are ORDER_APPROVED_FINAL_PRICE and OTP_ISSUED). Their
      // own order screen therefore sat on whatever it had loaded and could
      // only be corrected by closing and reopening it.
      //
      // Same payload, same event name, same one handler — and nothing here is
      // disclosed that `GET /orders/:id` would not already return to the
      // order's own client.
      if (updated.clientId) {
        this.realtimeGateway.emitToUser(String(updated.clientId), 'order:status', payload);
      }
      return updated;
    }

    // Distinguish "order doesn't exist / not visible to this tenant" from
    // "order exists but is no longer in the expected `from` state" (a race,
    // or simply a stale client) so callers get an accurate error.
    const existing = await this.orderModel
      .findById(orderId)
      .session(options.session ?? null)
      .exec();
    if (!existing) {
      throw new NotFoundException('Order not found');
    }
    throw new ConflictException(
      `Invalid transition from ${existing.status} to ${to} (expected current status ${from})`,
    );
  }
}
