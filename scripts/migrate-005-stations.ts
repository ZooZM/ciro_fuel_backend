import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/common/enums/user-role.enum';

export interface Migration005Summary {
  stationsCreated: number;
  ordersBackfilled: number;
  paymentEventsBackfilled: number;
}

const emptySummary = (): Migration005Summary => ({
  stationsCreated: 0,
  ordersBackfilled: 0,
  paymentEventsBackfilled: 0,
});

/**
 * Promotes each client's single embedded `user.station` (spec 004) into the
 * standalone `Station` collection (spec 005 D2/research R1), and back-fills
 * the two references that depend on it: `Order.stationId` and
 * `PaymentEvent.clientId`.
 *
 * Operates on raw collections, not Mongoose models, matching
 * `migrate-multi-tier.ts`'s precedent — consistent with how every migration
 * in this codebase is written, and avoids any risk of a model's schema
 * validation rejecting a document mid-migration.
 *
 * Idempotent by construction: every write is guarded by a filter that only
 * matches documents not yet carrying the new shape, so re-running after a
 * partial failure — or against an already-fully-migrated database — is
 * always safe. `priceBreakdown` is deliberately left unset on back-filled
 * orders (research R2): inventing historical pricing rates would fabricate
 * a financial record, which is exactly what this feature exists to stop.
 *
 * `user.station` itself is left untouched (not unset) — it stays as
 * read-only legacy data until a follow-up feature removes it once nothing
 * reads it, per data-model.md. Only `GET /auth/me` (T017) stops reading it.
 */
export async function migrate005Stations(connection: Connection): Promise<Migration005Summary> {
  const logger = new Logger('Migrate005Stations');
  const db = connection.db;
  if (!db) {
    throw new Error('Migration requires an active database connection');
  }
  const summary = emptySummary();

  // 1. One default Station per client that has an embedded station and no
  // Station document yet. `station: { $exists: true }` also naturally
  // excludes non-CLIENT roles, which never carry that field.
  const clientsNeedingMigration = await db
    .collection('users')
    .find({ role: UserRole.CLIENT, station: { $exists: true } })
    .toArray();

  for (const client of clientsNeedingMigration) {
    const alreadyMigrated = await db
      .collection('stations')
      .findOne({ clientId: client._id, isDefault: true });
    if (alreadyMigrated) {
      continue;
    }

    const station = client.station as {
      regionCode: string;
      governorateCode: string;
      location: unknown;
      addressText?: string;
      name?: string;
    };

    const now = new Date();
    await db.collection('stations').insertOne({
      companyId: client.companyId,
      clientId: client._id,
      name: station.name,
      regionCode: station.regionCode,
      governorateCode: station.governorateCode,
      location: station.location,
      addressText: station.addressText ?? '',
      isDefault: true,
      isFavourite: false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    summary.stationsCreated += 1;
  }
  logger.log(`Stations created from embedded user.station: ${summary.stationsCreated}`);

  // 2. Every existing order without a stationId gets its client's default
  // station — the closest honest approximation, since pre-005 orders never
  // recorded which station they came from (there was only ever one).
  const ordersMissingStation = await db
    .collection('orders')
    .find({ stationId: { $exists: false } })
    .toArray();

  for (const order of ordersMissingStation) {
    const defaultStation = await db
      .collection('stations')
      .findOne({ clientId: order.clientId, isDefault: true });
    if (!defaultStation) {
      // A client with no station on record at all (shouldn't happen post
      // spec-004 onboarding, but idempotency must not assume it can't) —
      // leave stationId unset rather than fabricate a reference.
      continue;
    }
    await db
      .collection('orders')
      .updateOne({ _id: order._id }, { $set: { stationId: defaultStation._id } });
    summary.ordersBackfilled += 1;
  }
  logger.log(`Orders back-filled with stationId: ${summary.ordersBackfilled}`);

  // 3. Every existing payment event without a clientId gets it resolved
  // through its order — the read path FR-023 needs this for.
  const eventsMissingClient = await db
    .collection('paymentevents')
    .find({ clientId: { $exists: false } })
    .toArray();

  for (const event of eventsMissingClient) {
    const order = await db.collection('orders').findOne({ _id: event.orderId });
    if (!order) {
      continue; // orphaned event referencing a deleted order — nothing to resolve
    }
    await db
      .collection('paymentevents')
      .updateOne({ _id: event._id }, { $set: { clientId: order.clientId } });
    summary.paymentEventsBackfilled += 1;
  }
  logger.log(`Payment events back-filled with clientId: ${summary.paymentEventsBackfilled}`);

  return summary;
}

async function runAsCli(): Promise<void> {
  const logger = new Logger('Migrate005Stations');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const connection = app.get<Connection>(getConnectionToken());
    const summary = await migrate005Stations(connection);
    logger.log(`Migration complete: ${JSON.stringify(summary)}`);
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
