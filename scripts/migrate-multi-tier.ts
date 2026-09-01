import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../src/app.module';
import { CompanyType } from '../src/common/enums/company-type.enum';
import { CompanyStatus } from '../src/common/enums/company-status.enum';
import { UserRole } from '../src/common/enums/user-role.enum';
import { PaymentMethod } from '../src/common/enums/payment-method.enum';
import { InvoiceState } from '../src/common/enums/invoice-state.enum';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { GovernorateCode, RegionCode } from '../src/common/enums/region.enum';

export interface MigrationSummary {
  companiesTaggedFuel: number;
  transportersCreated: number;
  driversReassigned: number;
  ordersMigrated: number;
  clientsMigrated: number;
  historicalInvoicesCreated: number;
  /** Client/transporter ids whose region could not be derived from any
   * coordinate on file — placed under RIYADH as a valid-but-provisional
   * value (FR-031's "flagged for admin completion"), not silently guessed
   * at and never revisited. There is no geo-boundary dataset in this
   * codebase (`regions.constants.ts` is a pure code list, spec 004 §"Region
   * reference data") to derive a real region from coordinates offline, and
   * calling an external geocoder from a migration script would make a
   * one-time, non-idempotent-feeling run depend on network availability —
   * so this list is the honest alternative to a fabricated guess.
   */
  needsRegionReview: string[];
}

const emptySummary = (): MigrationSummary => ({
  companiesTaggedFuel: 0,
  transportersCreated: 0,
  driversReassigned: 0,
  ordersMigrated: 0,
  clientsMigrated: 0,
  historicalInvoicesCreated: 0,
  needsRegionReview: [],
});

/**
 * Migrates pre-004 single-tier data into the multi-tier hierarchy
 * (plan.md §6, FR-031). Operates on raw collections, not Mongoose models —
 * a pre-migration document doesn't satisfy the current schema's required
 * fields (`Company.type`, `Order.fuelCompanyId`, `User.station`, ...), so a
 * typed model would refuse to read it back.
 *
 * Idempotent by construction: every write is guarded by a filter that only
 * matches documents not yet carrying the new shape, so re-running after a
 * partial failure — or against an already-fully-migrated database — is
 * always safe, and steps already done become no-ops rather than being
 * redone or duplicated.
 */
export async function migrateMultiTier(connection: Connection): Promise<MigrationSummary> {
  const logger = new Logger('MigrateMultiTier');
  const db = connection.db;
  if (!db) {
    throw new Error('Migration requires an active database connection');
  }
  const summary = emptySummary();

  // 1. Every existing Company -> type: FUEL.
  const companiesResult = await db
    .collection('companies')
    .updateMany(
      { type: { $exists: false } },
      { $set: { type: CompanyType.FUEL, servedRegions: [] } },
    );
  summary.companiesTaggedFuel = companiesResult.modifiedCount;
  logger.log(`Companies tagged FUEL: ${summary.companiesTaggedFuel}`);

  const fuelCompanies = await db.collection('companies').find({ type: CompanyType.FUEL }).toArray();

  for (const fuelCompany of fuelCompanies) {
    // 2. One Transportation Company per Fuel Company, seeded from its
    // existing drivers. Idempotency marker: `migratedFrom` on the
    // transporter itself, since the fuel company's own document carries no
    // back-reference to check against.
    const existingTransporter = await db.collection('companies').findOne({
      migratedFrom: fuelCompany._id,
    });
    if (existingTransporter) {
      continue;
    }

    const drivers = await db
      .collection('users')
      .find({ companyId: fuelCompany._id, role: UserRole.DRIVER })
      .toArray();

    const now = new Date();
    const transporterResult = await db.collection('companies').insertOne({
      name: `${fuelCompany.name as string} — Transport`,
      type: CompanyType.TRANSPORT,
      status: fuelCompany.status ?? CompanyStatus.ACTIVE,
      parentFuelCompanyId: fuelCompany._id,
      // No boundary dataset to derive a served region from client
      // coordinates (see MigrationSummary.needsRegionReview) — left empty,
      // flagged, for the Fuel Company to assign explicitly (FR-010).
      servedRegions: [],
      contactEmail: fuelCompany.contactEmail,
      contactPhone: fuelCompany.contactPhone,
      migratedFrom: fuelCompany._id,
      createdAt: now,
      updatedAt: now,
    });
    const transportCompanyId = transporterResult.insertedId;
    summary.transportersCreated += 1;
    summary.needsRegionReview.push(String(transportCompanyId));

    if (drivers.length > 0) {
      await db
        .collection('users')
        .updateMany(
          { _id: { $in: drivers.map((d) => d._id) } },
          { $set: { companyId: transportCompanyId } },
        );
      summary.driversReassigned += drivers.length;
    }
    logger.log(
      `Fuel company ${String(fuelCompany._id)}: created transporter ${String(transportCompanyId)} ` +
        `with ${drivers.length} driver(s)`,
    );

    // 3. Orders: companyId -> fuelCompanyId; transportCompanyId from the
    // migrated transporter; driverId from the old assignedDriverId field.
    const ordersResult = await db
      .collection('orders')
      .updateMany({ companyId: fuelCompany._id, fuelCompanyId: { $exists: false } }, [
        {
          $set: {
            fuelCompanyId: '$companyId',
            transportCompanyId,
            driverId: { $ifNull: ['$driverId', '$assignedDriverId'] },
            paymentMethod: { $ifNull: ['$paymentMethod', PaymentMethod.DIRECT] },
            deliveryAddressText: { $ifNull: ['$deliveryAddressText', ''] },
          },
        },
        { $unset: ['companyId', 'assignedDriverId'] },
      ]);
    summary.ordersMigrated += ordersResult.modifiedCount;
  }
  logger.log(`Orders migrated: ${summary.ordersMigrated}`);

  // 4. Clients: stationLocation -> station.location; region/governorate
  // flagged for review (no boundary dataset to resolve them from
  // coordinates); addressText empty (FR-013 already treats that as valid).
  const clients = await db
    .collection('users')
    .find({ role: UserRole.CLIENT, station: { $exists: false } })
    .toArray();
  for (const client of clients) {
    const location = client.stationLocation ?? client.location;
    await db.collection('users').updateOne(
      { _id: client._id },
      {
        $set: {
          station: {
            regionCode: RegionCode.RIYADH,
            governorateCode: GovernorateCode.RIYADH_CITY,
            location: location ?? { type: 'Point', coordinates: [0, 0] },
            addressText: '',
          },
        },
        $unset: { stationLocation: '' },
      },
    );
    summary.needsRegionReview.push(String(client._id));
  }
  summary.clientsMigrated = clients.length;
  logger.log(`Clients migrated to the station shape: ${summary.clientsMigrated}`);

  // 5. Issue a settled Invoice for every historical paid order so credit
  // maths starts consistent (plan.md §6.5) — idempotent via the unique
  // index on Invoice.orderId; an order already carrying an invoiceId, or
  // one whose invoice already exists, is left untouched either way.
  const paidOrders = await db
    .collection('orders')
    .find({
      status: { $in: [OrderStatus.IN_TRANSIT, OrderStatus.UNLOADING, OrderStatus.DELIVERED] },
      invoiceId: { $exists: false },
    })
    .toArray();
  for (const order of paidOrders) {
    const existingInvoice = await db.collection('invoices').findOne({ orderId: order._id });
    if (existingInvoice) {
      await db
        .collection('orders')
        .updateOne({ _id: order._id }, { $set: { invoiceId: existingInvoice._id } });
      continue;
    }
    const now = new Date();
    const invoiceResult = await db.collection('invoices').insertOne({
      orderId: order._id,
      fuelCompanyId: order.fuelCompanyId ?? order.companyId,
      clientId: order.clientId,
      amount: order.finalPrice ?? order.estimatedPrice,
      method: PaymentMethod.DIRECT,
      state: InvoiceState.SETTLED,
      payerRole: UserRole.CLIENT,
      settledAt: (order.updatedAt as Date | undefined) ?? now,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .collection('orders')
      .updateOne({ _id: order._id }, { $set: { invoiceId: invoiceResult.insertedId } });
    summary.historicalInvoicesCreated += 1;
  }
  logger.log(`Historical settled invoices created: ${summary.historicalInvoicesCreated}`);

  if (summary.needsRegionReview.length > 0) {
    logger.warn(
      `${summary.needsRegionReview.length} record(s) need a Fuel/Transportation Company admin to ` +
        `confirm their region — placed under a provisional RIYADH value: ` +
        summary.needsRegionReview.join(', '),
    );
  }

  return summary;
}

async function runAsCli(): Promise<void> {
  const logger = new Logger('MigrateMultiTier');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const connection = app.get<Connection>(getConnectionToken());
    const summary = await migrateMultiTier(connection);
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
