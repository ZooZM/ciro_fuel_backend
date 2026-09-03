import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { FuelType } from '../../../common/enums/fuel-type.enum';
import { ExchangeRequestState } from '../../../common/enums/exchange-request-state.enum';
import { markPartySet } from '../../../common/plugins/party-set.marker';

export type ExchangeRequestDocument = ExchangeRequest & Document;

/**
 * spec 013 T218/data-model.md, Part B (built only after Part A's isolation gate passed —
 * T217) — a fuel exchange request between exactly two fuel companies. `markPartySet`,
 * never `markTenantScoped`/`markMultiParty`: this is the one collection genuinely owned
 * by two companies, which is exactly what neither existing plugin can express (research
 * R3, `contracts/isolation-contract.md`).
 */
@Schema({ timestamps: true })
export class ExchangeRequest {
  // THE isolation field — array membership, not equality (party-set-scope.plugin.ts).
  // MUST hold exactly the raiser and the recipient; the plugin's own `pre('save')`
  // validates this rather than forcing a value (T212).
  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'Company', required: true })
  partyCompanyIds!: Types.ObjectId[];

  // Which party is which — direction (incoming/outgoing) is derived from this against
  // the viewer at read time, NEVER stored per-viewer (FR-079, FR-084).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  raisedByCompanyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true, immutable: true })
  recipientCompanyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, immutable: true })
  raisedByUserId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: FuelType, immutable: true })
  fuelType!: FuelType;

  @Prop({ required: true, min: 0, immutable: true })
  quantityLitres!: number;

  @Prop({ required: true, min: 0, immutable: true })
  unitPrice!: number;

  @Prop({ required: true, immutable: true })
  currency!: string;

  // A TERM of the agreement, not an instruction to the platform (FR-086a) — nothing
  // downstream ever schedules or enforces this.
  @Prop({ required: true, immutable: true })
  deliveryAt!: Date;

  @Prop({ required: true, immutable: true })
  deliveryPlaceText!: string;

  @Prop({ type: String, required: true, enum: ExchangeRequestState, default: ExchangeRequestState.AWAITING_RESPONSE })
  state!: ExchangeRequestState;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  resolvedBy?: Types.ObjectId;

  @Prop()
  resolvedAt?: Date;
}

export const ExchangeRequestSchema = SchemaFactory.createForClass(ExchangeRequest);
markPartySet(ExchangeRequestSchema);

// THE isolation index (party-set-scope.plugin.ts's own registration-time check fails
// startup without this — T213).
ExchangeRequestSchema.index({ partyCompanyIds: 1 });
ExchangeRequestSchema.index({ partyCompanyIds: 1, state: 1, createdAt: -1, _id: -1 });
