import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type PaymentEventDocument = PaymentEvent & Document;

export enum PaymentGateway {
  SADAD = 'SADAD',
  MADA = 'MADA',
}

export enum PaymentEventOutcome {
  CONFIRMED = 'CONFIRMED',
  DUPLICATE = 'DUPLICATE',
  OUT_OF_SEQUENCE = 'OUT_OF_SEQUENCE',
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
}

// Realizes the spec's "Payment Confirmation" entity: a record with
// outcome: CONFIRMED *is* the payment confirmation an order links via
// paymentConfirmationId; other outcomes form the audit/reconciliation trail.
//
// Tenant-read-scoped but write-exempt: the webhook that creates these runs
// with no AsyncLocalStorage context (public, unauthenticated route), so the
// tenant plugin bypasses on write; companyId is set explicitly by the
// webhook handler. Reads (e.g. admin listing) go through an authenticated
// request and ARE scoped normally.
@Schema({ timestamps: true })
export class PaymentEvent {
  @Prop({ required: true, unique: true })
  gatewayTransactionId!: string;

  @Prop({ type: String, required: true, enum: PaymentGateway })
  gateway!: PaymentGateway;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true })
  companyId!: Types.ObjectId;

  // spec 005 FR-023/research R5: denormalised from the order at write time
  // rather than resolved through it on every read — makes the client's own
  // payment history a direct, indexable query instead of a join, and is
  // what the { clientId, createdAt, _id } pagination index (T023) needs.
  // Optional: events predating this feature are back-filled by T016's
  // migration; genuinely orphaned ones (order deleted) stay unset.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  clientId?: Types.ObjectId;

  @Prop({ required: true })
  amount!: number;

  @Prop({ required: true, default: 'SAR' })
  currency!: string;

  @Prop({ type: String, required: true, enum: PaymentEventOutcome })
  outcome!: PaymentEventOutcome;

  @Prop({ type: Object })
  rawPayload?: Record<string, unknown>;
}

export const PaymentEventSchema = SchemaFactory.createForClass(PaymentEvent);
markTenantScoped(PaymentEventSchema);
PaymentEventSchema.index({ orderId: 1 });
// spec 005 FR-023/research R3: supports GET /payments' cursor pagination.
PaymentEventSchema.index({ clientId: 1, createdAt: -1, _id: -1 });
