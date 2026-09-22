import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../src/app.module';
import { ExchangeRequestState } from '../src/common/enums/exchange-request-state.enum';
import { ExchangeOfferState } from '../src/common/enums/exchange-offer-state.enum';
import { ProposalOutcome } from '../src/common/enums/proposal-outcome.enum';
import { GovernorateCode } from '../src/common/enums/region.enum';

/** No boundary dataset to derive a real GovernorateCode from free text (see
 * `needsCityReview` above) — a provisional, valid enum value, never a guess presented
 * as fact. */
const PROVISIONAL_CITY = GovernorateCode.RIYADH_CITY;

/** research R5's state mapping table — the whole of this migration's business logic. */
function mapState(state: ExchangeRequestState): {
  offerState: ExchangeOfferState;
  proposalOutcome?: ProposalOutcome;
} | undefined {
  switch (state) {
    case ExchangeRequestState.AWAITING_RESPONSE:
      return { offerState: ExchangeOfferState.OPEN };
    case ExchangeRequestState.ACCEPTED:
      return { offerState: ExchangeOfferState.AWARDED, proposalOutcome: ProposalOutcome.AWARDED };
    case ExchangeRequestState.DECLINED:
      return { offerState: ExchangeOfferState.CLOSED_NO_AWARD, proposalOutcome: ProposalOutcome.DECLINED };
    case ExchangeRequestState.WITHDRAWN:
      return { offerState: ExchangeOfferState.WITHDRAWN };
    default:
      return undefined;
  }
}

/**
 * spec 016 (broadcast fuel exchange offers) research R5/FR-039/FR-039a/FR-039b — the
 * feature's one irreversible step. Converts each `ExchangeRequest` into one
 * `ExchangeOffer` that keeps its ORIGINAL two-company audience
 * (`openToMarket: false`, `partyCompanyIds` unchanged) — never `true`, or a historical
 * private request, including one never answered, is published to every fuel company on
 * the platform the moment this code deploys (SC-010). MUST run against each target
 * environment BEFORE this code deploys there — the new read path (broadcast offers)
 * exists only once the code is live, so the data must already be in the new shape.
 *
 * Idempotent via `migratedFromRequestId` (`ExchangeOffer`'s own unique sparse index) —
 * re-running is always safe: an already-migrated request is skipped, not re-written.
 * Operates on raw collections, matching every other migration in this repository — a
 * pre-migration `ExchangeRequest` document must be read exactly as it was written, not
 * as whatever the CURRENT schema happens to require today.
 *
 * FR-039b: exits non-zero (via `unmapped` being non-empty) on any record whose state
 * this migration cannot map — silence here would mean a request quietly left behind,
 * reachable by nothing once `FR-040` removes the old endpoints.
 */
export async function migrateExchangeRequestsToOffers(
  connection: Connection,
  options: { dryRun?: boolean } = {},
): Promise<MigrateExchangeRequestsSummary> {
  const logger = new Logger('MigrateExchangeRequestsToOffers');
  const db = connection.db;
  if (!db) {
    throw new Error('Migration requires an active database connection');
  }
  const dryRun = options.dryRun ?? false;
  const summary = emptySummary();

  const requests = await db.collection('exchangerequests').find({}).toArray();
  summary.total = requests.length;
  logger.log(`${requests.length} exchange request(s) found.`);

  for (const req of requests) {
    const existingOffer = await db
      .collection('exchangeoffers')
      .findOne({ migratedFromRequestId: req._id });
    if (existingOffer) {
      summary.alreadyMigrated += 1;
      continue;
    }

    const mapping = mapState(req.state as ExchangeRequestState);
    if (!mapping) {
      summary.unmapped.push({ requestId: String(req._id), state: req.state });
      logger.error(`Request ${String(req._id)} has an unmappable state: ${String(req.state)}`);
      continue;
    }

    if (dryRun) {
      summary.offersCreated += 1;
      if (mapping.proposalOutcome) summary.proposalsCreated += 1;
      continue;
    }

    const now = new Date();
    const offerDoc: Record<string, unknown> = {
      // THE non-negotiable field (FR-039a) — this migration's entire safety property.
      openToMarket: false,
      partyCompanyIds: [req.raisedByCompanyId, req.recipientCompanyId],
      raisedByCompanyId: req.raisedByCompanyId,
      raisedByUserId: req.raisedByUserId,
      fuelType: req.fuelType,
      quantityLitres: req.quantityLitres,
      deliveryAt: req.deliveryAt,
      // No GovernorateCode exists for the legacy free-text place — a provisional value,
      // flagged below, with the original text preserved verbatim rather than discarded.
      city: PROVISIONAL_CITY,
      notes: `[migrated] ${String(req.deliveryPlaceText ?? '')}`.slice(0, 1000),
      state: mapping.offerState,
      resolvedBy: req.resolvedBy,
      resolvedAt: req.resolvedAt,
      migratedFromRequestId: req._id,
      createdAt: req.createdAt ?? now,
      updatedAt: now,
    };

    // T019a/FR-039/FR-013: an ACCEPTED request's agreement must remain ATTRIBUTABLE —
    // which company supplied (the raiser, unchanged) and which received (the original
    // recipient, who accepted) — with the original terms preserved, exactly as
    // FR-014c requires of a live award.
    if (req.state === ExchangeRequestState.ACCEPTED) {
      offerDoc.awardedCompanyId = req.recipientCompanyId;
      offerDoc.agreedUnitPrice = req.unitPrice;
      offerDoc.agreedQuantityLitres = req.quantityLitres;
      offerDoc.agreedTotal = (req.unitPrice as number) * (req.quantityLitres as number);
      offerDoc.currency = req.currency;
    }

    const offerResult = await db.collection('exchangeoffers').insertOne(offerDoc);
    summary.offersCreated += 1;
    summary.needsCityReview.push(String(offerResult.insertedId));

    if (mapping.proposalOutcome) {
      // The recipient's only recorded action IS `resolvedBy` — `ExchangeRequest` never
      // had a distinct "responding user" field beyond it (only the raiser has its own
      // `raisedByUserId`), so `resolvedBy` is the only truthful source for
      // `proposingUserId` here.
      const isAwarded = mapping.proposalOutcome === ProposalOutcome.AWARDED;
      await db.collection('exchangeproposals').insertOne({
        offerId: offerResult.insertedId,
        offerRaisedByCompanyId: req.raisedByCompanyId,
        proposingCompanyId: req.recipientCompanyId,
        proposingUserId: req.resolvedBy,
        outcome: mapping.proposalOutcome,
        // A decline carries no price — the key itself is omitted, never written as
        // `null`/`undefined`, so it reads identically to a live decline's document.
        ...(isAwarded ? { unitPrice: req.unitPrice, currency: req.currency } : {}),
        respondedAt: req.resolvedAt ?? now,
        resolvedAt: req.resolvedAt,
        createdAt: req.resolvedAt ?? now,
        updatedAt: now,
      });
      summary.proposalsCreated += 1;
    }
  }

  logger.log(
    `Done: ${summary.offersCreated} offer(s) created, ${summary.proposalsCreated} proposal(s) created, ` +
      `${summary.alreadyMigrated} already migrated, ${summary.unmapped.length} unmapped.`,
  );
  if (summary.needsCityReview.length > 0) {
    logger.warn(
      `${summary.needsCityReview.length} migrated offer(s) carry a PROVISIONAL city — a fuel ` +
        `company admin should confirm it against the original text preserved in "notes": ` +
        summary.needsCityReview.join(', '),
    );
  }
  if (dryRun) {
    logger.log('Dry run — no writes were made.');
  }
  return summary;
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes('--dry-run') };
}

async function runAsCli(): Promise<void> {
  const logger = new Logger('MigrateExchangeRequestsToOffers');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const connection = app.get<Connection>(getConnectionToken());
    const summary = await migrateExchangeRequestsToOffers(connection, parseArgs(process.argv.slice(2)));
    logger.log(`Summary: ${JSON.stringify(summary)}`);
    if (summary.unmapped.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  runAsCli().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
