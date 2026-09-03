import { Injectable } from '@nestjs/common';
import { ExtractedSupplierInvoiceFields, SupplierInvoiceExtractionPort } from './supplier-invoice-extraction.port';

/**
 * spec 013 T179/R8 — extracts nothing, always. Registered as the default (and, today, only)
 * implementation of {@link SupplierInvoiceExtractionPort}.
 *
 * This is not a stub awaiting a real implementation to become "done" — FR-073a-ii
 * (confirmation is what is recorded) and FR-073a-iii (manual entry when extraction yields
 * nothing) together mean a null extractor is a FULLY WORKING feature: the administrator
 * enters every field by hand and confirms, exactly the same path a real extractor's
 * corrected output would take. The least predictable part of this story (document OCR/LLM
 * accuracy) is also the only genuinely deferrable part.
 */
@Injectable()
export class NullSupplierInvoiceExtractor implements SupplierInvoiceExtractionPort {
  extract(): Promise<ExtractedSupplierInvoiceFields> {
    return Promise.resolve({});
  }
}
