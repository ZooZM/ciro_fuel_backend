import { Logger } from '@nestjs/common';
import { Connection } from 'mongoose';
import { ExchangeRequestState } from '../../src/common/enums/exchange-request-state.enum';
import { ExchangeOfferState } from '../../src/common/enums/exchange-offer-state.enum';
import { ProposalOutcome } from '../../src/common/enums/proposal-outcome.enum';
import { GovernorateCode } from '../../src/common/enums/region.enum';
export interface MigrateExchangeRequestsSummary {
  total: number;
  offersCreated: number;
  proposalsCreated: number;
  alreadyMigrated: number;
  unmapped: { requestId: string; state: unknown }[];
  /** `ExchangeOffer.city` is a `GovernorateCode`; the legacy `deliveryPlaceText` is
   * free text with no such code. No boundary dataset exists in this codebase to
   * derive one (the same gap `migrate-multi-tier.ts` already documents for regions),
   * so every migrated offer gets a provisional value and its original text is
   * preserved verbatim in `notes` — never silently discarded. Flagged here for a
   * fuel company admin to confirm, the same discipline `needsRegionReview` applies. */
  needsCityReview: string[];
}

const emptySummary = (): MigrateExchangeRequestsSummary => ({
  total: 0,
  offersCreated: 0,
  proposalsCreated: 0,
  alreadyMigrated: 0,
  unmapped: [],
  needsCityReview: [],
});
