import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

// Exactly mirrors data-model.md's state machine diagram (FR-006/FR-025).
const TRANSITIONS: Record<OrderStatus, TransitionRule[]> = {
  [OrderStatus.PENDING_APPROVAL]: [
    { to: OrderStatus.APPROVED },
    { to: OrderStatus.REJECTED },
    { to: OrderStatus.CANCELLED },
  ],
  [OrderStatus.APPROVED]: [{ to: OrderStatus.ASSIGNED_TO_DRIVER }, { to: OrderStatus.CANCELLED }],
  [OrderStatus.ASSIGNED_TO_DRIVER]: [
    { to: OrderStatus.PENDING_PAYMENT },
    { to: OrderStatus.CANCELLED },
  ],
  [OrderStatus.PENDING_PAYMENT]: [
    { to: OrderStatus.IN_TRANSIT },
    { to: OrderStatus.APPROVED }, // payment-deadline reversion (FR-015a)
    { to: OrderStatus.CANCELLED }, // admin cancel OR client declines final price (FR-009)
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
          $set: { status: to, ...options.extraSet },
          $push: { statusHistory: historyEntry },
          ...(options.extraUnset?.length
            ? { $unset: Object.fromEntries(options.extraUnset.map((f) => [f, ''])) }
            : {}),
        },
        { new: true, session: options.session },
      )
      .exec();

    if (updated) {
      // Emitted synchronously with the write rather than after commit — the
      // one edge case this misses (transaction rolls back after this point)
      // is rare and self-corrects on the watcher's next fetch; not worth the
      // complexity of deferring emission for a system this size.
      this.realtimeGateway.emitToOrderRoom(String(orderId), 'order:status', {
        orderId: String(orderId),
        from,
        to,
        at: historyEntry.at,
      });
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
