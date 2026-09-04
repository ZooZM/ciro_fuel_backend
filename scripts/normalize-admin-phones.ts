import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/common/enums/user-role.enum';
import { E164_PATTERN } from '../src/common/constants/phone';

const ADMIN_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.FUEL_COMPANY_ADMIN,
  UserRole.TRANSPORT_COMPANY_ADMIN,
];

export interface NormalizeAdminPhonesOptions {
  /** `{ "<email>": "+9665XXXXXXXX" }` — administrators to assign a real number to. */
  map?: Record<string, string>;
  /** Any admin still non-E.164 after `map` is applied is deactivated. */
  deactivateUnmapped?: boolean;
  /** Report only; make no writes. Default true unless `map`/`deactivateUnmapped` given. */
  dryRun?: boolean;
}

export interface NormalizeAdminPhonesSummary {
  offendersBefore: { email: string; phone: unknown; role: string }[];
  numbersAssigned: number;
  accountsDeactivated: number;
  offendersRemaining: { email: string; role: string }[];
}

/**
 * spec 015 R5 / T041 — an administrator's phone becomes a login identifier
 * and the partial unique phone index is extended to the three admin roles
 * (T044). That index build FAILS at boot while two admin documents share a
 * non-E.164 placeholder (the seeded SUPER_ADMIN writes the literal 'N/A'),
 * and on this platform a failed index build means the service does not start.
 *
 * This script must be run against EACH target environment BEFORE the schema
 * change is deployed there (T041a) — `autoIndex` is on, so the code deploy
 * alone triggers the build. A green local run does not protect production.
 *
 * Operates on the raw collection, matching every other migration in this
 * repository. Idempotent: once every admin phone is E.164 it reports 0 and
 * exits 0.
 */
export async function normalizeAdminPhones(
  connection: Connection,
  options: NormalizeAdminPhonesOptions = {},
): Promise<NormalizeAdminPhonesSummary> {
  const logger = new Logger('NormalizeAdminPhones');
  const db = connection.db;
  if (!db) {
    throw new Error('A live database connection is required');
  }
  const map = options.map ?? {};
  const willWrite = Object.keys(map).length > 0 || options.deactivateUnmapped === true;
  const dryRun = options.dryRun ?? !willWrite;

  const isE164 = (v: unknown): v is string => typeof v === 'string' && E164_PATTERN.test(v);

  const admins = await db
    .collection('users')
    .find({ role: { $in: ADMIN_ROLES } })
    .project({ email: 1, phone: 1, role: 1 })
    .toArray();

  const offenders = admins.filter((a) => !isE164(a.phone));
  const summary: NormalizeAdminPhonesSummary = {
    offendersBefore: offenders.map((a) => ({ email: a.email, phone: a.phone, role: a.role })),
    numbersAssigned: 0,
    accountsDeactivated: 0,
    offendersRemaining: [],
  };

  logger.log(
    `${admins.length} administrator account(s); ${offenders.length} with a non-E.164 phone.`,
  );
  for (const o of offenders) {
    logger.warn(`  ${o.role} <${o.email}> phone=${JSON.stringify(o.phone)}`);
  }

  if (dryRun) {
    logger.log('Dry run — no writes. Re-run with --map / --deactivate-unmapped to normalise.');
    summary.offendersRemaining = summary.offendersBefore.map((o) => ({
      email: o.email,
      role: o.role,
    }));
    return summary;
  }

  for (const o of offenders) {
    const assigned = map[o.email];
    if (assigned) {
      if (!isE164(assigned)) {
        throw new Error(`Mapped phone for ${o.email} is not E.164: ${assigned}`);
      }
      await db.collection('users').updateOne({ _id: o._id }, { $set: { phone: assigned } });
      summary.numbersAssigned += 1;
      logger.log(`  assigned ${assigned} to <${o.email}>`);
    } else if (options.deactivateUnmapped) {
      await db.collection('users').updateOne({ _id: o._id }, { $set: { isActive: false } });
      summary.accountsDeactivated += 1;
      logger.warn(`  deactivated <${o.email}> (no mapped number)`);
    } else {
      summary.offendersRemaining.push({ email: o.email, role: o.role });
    }
  }

  // Re-check so the caller (and the runbook) knows whether it is now safe to
  // deploy the index extension.
  const stillBad = await db
    .collection('users')
    .find({ role: { $in: ADMIN_ROLES } })
    .project({ email: 1, phone: 1, role: 1 })
    .toArray();
  summary.offendersRemaining = stillBad
    .filter((a) => !isE164(a.phone))
    .map((a) => ({ email: a.email, role: a.role }));

  if (summary.offendersRemaining.length > 0) {
    logger.error(
      `${summary.offendersRemaining.length} administrator account(s) still have a non-E.164 ` +
        'phone — the extended unique index will FAIL to build. Resolve before deploying T044.',
    );
  } else {
    logger.log('All administrator phones are E.164 — safe to deploy the index extension.');
  }
  return summary;
}

function parseArgs(argv: string[]): NormalizeAdminPhonesOptions {
  const opts: NormalizeAdminPhonesOptions = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--deactivate-unmapped') opts.deactivateUnmapped = true;
    else if (argv[i] === '--map') opts.map = JSON.parse(argv[++i] ?? '{}');
  }
  if (!opts.map && process.env.ADMIN_PHONE_MAP) {
    opts.map = JSON.parse(process.env.ADMIN_PHONE_MAP);
  }
  return opts;
}

async function runAsCli(): Promise<void> {
  const logger = new Logger('NormalizeAdminPhones');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const connection = app.get<Connection>(getConnectionToken());
    const summary = await normalizeAdminPhones(connection, parseArgs(process.argv.slice(2)));
    logger.log(`Done: ${JSON.stringify(summary)}`);
    if (summary.offendersRemaining.length > 0) {
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
