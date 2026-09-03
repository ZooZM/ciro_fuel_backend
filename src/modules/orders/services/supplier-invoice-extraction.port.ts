import { FuelType } from '../../../common/enums/fuel-type.enum';

export interface ExtractedSupplierInvoiceFields {
  quantityLitres?: number;
  fuelType?: FuelType;
  reference?: string;
  issueDate?: Date;
}

/**
 * spec 013 T178/R8 — document in, candidate field values out. An ABSTRACT CLASS (not an
 * interface), same reasoning as `FileStorage`: it works as a Nest DI token while staying a
 * compile-time contract, so `SupplierInvoicesService` never learns whether a real OCR/LLM
 * extractor answered or the null one did (Constitution IV).
 *
 * FR-073a-ii/FR-073a-iii together make the extraction accuracy irrelevant to whether this
 * story WORKS: every field is correctable before confirmation, and every field extraction
 * doesn't yield is enterable by hand. `NullSupplierInvoiceExtractor` is the seam's only
 * implementation for now — a real one is added later behind this exact port, or not at
 * all, with zero change to the confirm/reconcile path either way.
 */
export abstract class SupplierInvoiceExtractionPort {
  abstract extract(params: { buffer: Buffer; mimeType: string }): Promise<ExtractedSupplierInvoiceFields>;
}
