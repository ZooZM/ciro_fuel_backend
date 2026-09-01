import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { PaymentMethod } from '../../../common/enums/payment-method.enum';
import { InvoiceState } from '../../../common/enums/invoice-state.enum';
import { UserRole } from '../../../common/enums/user-role.enum';
import { markMultiParty } from '../../../common/plugins/multi-party.marker';
import { PriceBreakdown, PriceBreakdownSchema } from '../../orders/schemas/order.schema';

export type InvoiceDocument = Invoice & Document;

/**
 * One invoice per order (spec 004 FR-020), issued at approval once the
 * final price is known. Multi-party like Order (plan.md §1): visible to the
 * Fuel Company that owns it, the client it's billed to, and — once routing
 * resolves one and only for DEFERRED — the Transportation Company that pays
 * it (FR-022).
 */
@Schema({ timestamps: true })
export class Invoice {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true, immutable: true })
  orderId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  fuelCompanyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  clientId!: Types.ObjectId;

  // Stamped once routing resolves a transporter for a DEFERRED invoice
  // (FR-022) — absent for DIRECT/CREDIT, and absent for DEFERRED until
  // routed (issuance always precedes routing, plan.md §4).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company' })
  transportCompanyId?: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  amount!: number;

  // spec 005 FR-011e: copied from the order at issuance, never recomputed —
  // an invoice stays self-consistent even if its order is later amended.
  // `priceBreakdown.total` MUST equal `amount` (asserted at issuance,
  // invoices.service.ts) — two figures for one debt is not an acceptable
  // outcome. Optional: invoices issued before this feature have none.
  @Prop({ type: PriceBreakdownSchema })
  priceBreakdown?: PriceBreakdown;

  @Prop({ type: String, required: true, enum: PaymentMethod, immutable: true })
  method!: PaymentMethod;

  @Prop({ type: String, required: true, enum: InvoiceState, default: InvoiceState.ISSUED })
  state!: InvoiceState;

  // Who owes this invoice: the client for DIRECT/CREDIT, the Transportation
  // Company for DEFERRED (FR-021/FR-022) — set once at issuance, immutable.
  @Prop({ type: String, required: true, enum: UserRole, immutable: true })
  payerRole!: UserRole;

  @Prop()
  settledAt?: Date;

  // The gateway transaction id (DIRECT, via the Sadad/Mada webhook) or an
  // actor-supplied reference (manual settlement) — informational only;
  // PaymentEvent.gatewayTransactionId is the actual dedup key for the
  // webhook path (FR-026).
  @Prop()
  paymentReference?: string;
}

export const InvoiceSchema = SchemaFactory.createForClass(Invoice);
markMultiParty(InvoiceSchema);

// Exactly one invoice per order, ever (FR-020) — approval issues it once;
// nothing re-approves an already-invoiced order.
InvoiceSchema.index({ orderId: 1 }, { unique: true });
InvoiceSchema.index({ fuelCompanyId: 1, state: 1 });
// Available-credit derivation sums exactly this shape (FR-024a).
InvoiceSchema.index({ clientId: 1, method: 1, state: 1 });
InvoiceSchema.index({ transportCompanyId: 1, state: 1 });

// spec 005 FR-048f/research R3: supports GET /invoices' cursor pagination,
// sorted outstanding-before-settled then newest-first within each group —
// `state` in the prefix (unlike every other paginated collection here) is
// what makes that ordering possible. Ascending on `state` happens to place
// ISSUED before SETTLED before VOID purely because those enum VALUES sort
// that way alphabetically (common/enums/invoice-state.enum.ts) — if a new
// InvoiceState is ever added, re-check that it still alphabetizes as
// "outstanding, then everything else" before relying on this index's order.
InvoiceSchema.index({ clientId: 1, state: 1, createdAt: -1, _id: -1 });
