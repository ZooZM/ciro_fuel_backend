import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type FileRecordDocument = FileRecord & Document;

export enum FilePurpose {
  COMMERCIAL_REGISTER = 'COMMERCIAL_REGISTER',
  PROFILE_PICTURE = 'PROFILE_PICTURE',
}

@Schema({ timestamps: true })
export class FileRecord {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true })
  companyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  ownerUserId?: Types.ObjectId;

  @Prop({ type: String, required: true, enum: FilePurpose })
  purpose!: FilePurpose;

  // Always server-generated (sys_storge/{companyId}/{uuid}{ext}) — never
  // derived from client input, so path traversal is structurally impossible (R10).
  @Prop({ required: true })
  storagePath!: string;

  @Prop({ required: true })
  mimeType!: string;

  @Prop({ required: true })
  sizeBytes!: number;

  @Prop({ required: true })
  originalName!: string;
}

export const FileRecordSchema = SchemaFactory.createForClass(FileRecord);
markTenantScoped(FileRecordSchema);
FileRecordSchema.index({ companyId: 1, purpose: 1 });
