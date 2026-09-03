import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { markTenantScoped } from '../../../common/plugins/tenant-scoped.marker';

export type FileRecordDocument = FileRecord & Document;

export enum FilePurpose {
  COMMERCIAL_REGISTER = 'COMMERCIAL_REGISTER',
  PROFILE_PICTURE = 'PROFILE_PICTURE',
  // spec 013 T165/FR-067 — evidence attached to a `PAYMENT_RECORDED` AccountMovement.
  PAYMENT_EVIDENCE = 'PAYMENT_EVIDENCE',
  // spec 013 T185/FR-073a — the document behind `Order.supplierInvoices`.
  SUPPLIER_INVOICE = 'SUPPLIER_INVOICE',
}

@Schema({ timestamps: true })
export class FileRecord {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Company', required: true })
  companyId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  ownerUserId?: Types.ObjectId;

  @Prop({ type: String, required: true, enum: FilePurpose })
  purpose!: FilePurpose;

  /**
   * The key the bytes are stored under. Always server-generated
   * (`sys_storge/{companyId}/{uuid}{ext}`) — never derived from client input,
   * so path traversal is structurally impossible (spec 001 R10).
   *
   * **It keeps its name and its type** (spec 012 FR-038). Since Story 6 the
   * CONTENT changed — an object key rather than an absolute filesystem path —
   * but renaming it to `objectKey` would read better and would break the
   * response payload freeze. Neither client reads it (both address files by
   * `_id`) and it was never stable anyway: it previously embedded
   * `process.cwd()` and so already differed between machines.
   *
   * **The `sys_storge/{companyId}/…` prefix enforces NOTHING** (FR-040a). The
   * object store serves any object to any holder of a valid signed URL
   * regardless of its key path — the tenant boundary is held entirely by the
   * tenant-scoped read in `FilesService.findForDownload`, which must succeed
   * before a URL is signed. The prefix is organisation, retained because the
   * constitution names `sys_storge`; any future code that reads tenancy out of
   * a key path is a defect.
   */
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
/**
 * DO NOT REMOVE (spec 012 T066). This marker is the ONLY tenant check on the
 * download path: `files.controller.ts:download` has no explicit check and
 * correctly needs none, because `findForDownload`'s `findById` runs through the
 * scoping plugin and a cross-tenant id resolves to nothing — a 404, never a
 * 403. The controller LOOKS unprotected; removing this line opens a
 * cross-tenant read with no other change and no failing test elsewhere.
 */
markTenantScoped(FileRecordSchema);
FileRecordSchema.index({ companyId: 1, purpose: 1 });
