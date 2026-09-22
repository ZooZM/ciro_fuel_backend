import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { Order, OrderDocument, SupplierInvoice } from '../schemas/order.schema';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { ErrorCode } from '../../../common/enums/error-code.enum';
import { FilesService } from '../../files/files.service';
import { FilePurpose } from '../../files/schemas/file.schema';
import { SupplierInvoiceExtractionPort } from './supplier-invoice-extraction.port';
import { LitreBalancesService } from '../../litre-balances/litre-balances.service';
import { ConfirmedSupplierInvoiceDataDto } from '../dto/confirm-supplier-invoice.dto';

const INELIGIBLE_STATUSES = new Set([OrderStatus.CANCELLED, OrderStatus.REJECTED]);

export interface UploadSupplierInvoiceResult {
  fileId: string;
  extracted: Record<string, unknown>;
  orderedQuantityLitres: number;
}

/**
 * spec 013 Phase 14 (US11) — the supplier-invoice upload/confirm/replace flow and the
 * reconciliation it drives. A dedicated service rather than folding into
 * `OrdersService` (already large): this owns one cohesive concern —
 * `Order.supplierInvoices` plus the `LitreBalancesService` calls that must commit
 * alongside it — mirroring `BillingService`'s split from `InvoicesService` in Phase 12.
 */
@Injectable()
export class SupplierInvoicesService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly filesService: FilesService,
    private readonly extractionPort: SupplierInvoiceExtractionPort,
    private readonly litreBalancesService: LitreBalancesService,
  ) {}

  /**
   * T185/FR-073a-i/SC-014c — stores the document and attempts extraction. Records
   * NOTHING on the order and moves no balance; the file exists, but nothing points at it
   * as a supplier invoice until {@link confirm} runs. An abandoned upload therefore
   * leaves no trace beyond an orphaned `FileRecord` — cheaper to tolerate than to design
   * around, matching `files.service.ts`'s own "bytes first, record second" ordering
   * doing the equivalent for a rejected upload.
   */
  async upload(
    order: OrderDocument,
    ownerUserId: string,
    file: { buffer: Buffer; mimeType: string; originalName: string },
  ): Promise<UploadSupplierInvoiceResult> {
    const record = await this.filesService.store({
      companyId: order.fuelCompanyId,
      ownerUserId,
      purpose: FilePurpose.SUPPLIER_INVOICE,
      buffer: file.buffer,
      mimeType: file.mimeType,
      originalName: file.originalName,
    });
    const extracted = await this.extractionPort.extract({
      buffer: file.buffer,
      mimeType: file.mimeType,
    });
    return {
      fileId: String(record._id),
      extracted: extracted as unknown as Record<string, unknown>,
      orderedQuantityLitres: order.quantityLiters,
    };
  }

  private assertEligible(order: OrderDocument): void {
    if (INELIGIBLE_STATUSES.has(order.status)) {
      throw new ConflictException({
        error: ErrorCode.SUPPLIER_INVOICE_ORDER_NOT_ELIGIBLE,
        message: `Order is ${order.status} — there is nothing to reconcile a delivered quantity against`,
      });
    }
  }

  private assertGradeMatches(
    order: OrderDocument,
    confirmed: ConfirmedSupplierInvoiceDataDto,
  ): void {
    if (confirmed.fuelType !== order.fuelType) {
      throw new BadRequestException({
        error: ErrorCode.SUPPLIER_INVOICE_GRADE_MISMATCH,
        message: `Confirmed grade ${confirmed.fuelType} does not match the order's own grade ${order.fuelType}`,
      });
    }
  }

  private currentEntry(order: OrderDocument): SupplierInvoice | undefined {
    return order.supplierInvoices.find((si) => !si.supersededAt && si.confirmed);
  }

  /**
   * T186/T187/T188/T189/T190/Principle V — records the invoice and applies the balance
   * movement in ONE transaction: an order can never end up with a confirmed supplier
   * invoice whose shortfall/excess was never reflected in the owner's balance, or a
   * balance movement with no confirmed invoice behind it.
   */
  async confirm(
    order: OrderDocument,
    dto: { fileId: string; confirmed: ConfirmedSupplierInvoiceDataDto },
    actorId: string,
  ): Promise<{ order: OrderDocument; shortfallLitres: number; wentNegative: boolean }> {
    this.assertEligible(order);
    this.assertGradeMatches(order, dto.confirmed);
    if (this.currentEntry(order)) {
      throw new ConflictException({
        error: ErrorCode.SUPPLIER_INVOICE_ALREADY_RECORDED,
        message:
          'This order already has a confirmed supplier invoice — use the replace endpoint instead',
      });
    }

    const session = await this.connection.startSession();
    let result!: { order: OrderDocument; shortfallLitres: number; wentNegative: boolean };
    try {
      await session.withTransaction(async () => {
        const reconciliation = await this.litreBalancesService.recordReconciliation(
          order.fuelCompanyId,
          order.clientId,
          dto.confirmed.fuelType,
          order._id as Types.ObjectId,
          order.quantityLiters,
          dto.confirmed.quantityLitres,
          actorId,
          session,
        );

        const updated = await this.orderModel
          .findOneAndUpdate(
            { _id: order._id },
            {
              $push: {
                supplierInvoices: {
                  fileId: new Types.ObjectId(dto.fileId),
                  confirmed: {
                    quantityLitres: dto.confirmed.quantityLitres,
                    fuelType: dto.confirmed.fuelType,
                    reference: dto.confirmed.reference,
                    issueDate: new Date(dto.confirmed.issueDate),
                  },
                  confirmedBy: new Types.ObjectId(actorId),
                  confirmedAt: new Date(),
                } satisfies Partial<SupplierInvoice>,
              },
            },
            { new: true, session },
          )
          .exec();

        result = {
          order: updated!,
          shortfallLitres: reconciliation.shortfallLitres,
          wentNegative: reconciliation.wentNegative,
        };
      });
    } finally {
      await session.endSession();
    }
    return result;
  }

  /**
   * T192/FR-073e — the replace path: supersedes whichever entry is current (if any) and
   * restates the balance movement, inside one transaction alongside it. A `PUT` with no
   * prior confirmed entry behaves exactly like {@link confirm} (there is nothing to
   * supersede) rather than refusing — the two endpoints differ only in whether an
   * existing entry needs marking `supersededAt` first.
   */
  async replace(
    order: OrderDocument,
    dto: { fileId: string; confirmed: ConfirmedSupplierInvoiceDataDto },
    actorId: string,
  ): Promise<{ order: OrderDocument; shortfallLitres: number; wentNegative: boolean }> {
    this.assertEligible(order);
    this.assertGradeMatches(order, dto.confirmed);
    const existing = this.currentEntry(order);

    const session = await this.connection.startSession();
    let result!: { order: OrderDocument; shortfallLitres: number; wentNegative: boolean };
    try {
      await session.withTransaction(async () => {
        if (existing) {
          await this.orderModel
            .updateOne(
              { _id: order._id, 'supplierInvoices._id': existing._id },
              { $set: { 'supplierInvoices.$.supersededAt': new Date() } },
              { session },
            )
            .exec();
        }

        const reconciliation = await this.litreBalancesService.restateReconciliation(
          order.fuelCompanyId,
          order.clientId,
          dto.confirmed.fuelType,
          order._id as Types.ObjectId,
          order.quantityLiters,
          dto.confirmed.quantityLitres,
          actorId,
          session,
        );

        const updated = await this.orderModel
          .findOneAndUpdate(
            { _id: order._id },
            {
              $push: {
                supplierInvoices: {
                  fileId: new Types.ObjectId(dto.fileId),
                  confirmed: {
                    quantityLitres: dto.confirmed.quantityLitres,
                    fuelType: dto.confirmed.fuelType,
                    reference: dto.confirmed.reference,
                    issueDate: new Date(dto.confirmed.issueDate),
                  },
                  confirmedBy: new Types.ObjectId(actorId),
                  confirmedAt: new Date(),
                } satisfies Partial<SupplierInvoice>,
              },
            },
            { new: true, session },
          )
          .exec();

        result = {
          order: updated!,
          shortfallLitres: reconciliation.shortfallLitres,
          wentNegative: reconciliation.wentNegative,
        };
      });
    } finally {
      await session.endSession();
    }
    return result;
  }
}
