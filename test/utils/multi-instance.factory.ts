import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap/configure-app';

/**
 * TWO applications, one database, one Redis — spec 012 T098, FR-069/FR-070.
 *
 * This harness is the only way Story 9's guarantees are observable at all. A
 * single-instance suite cannot tell a working scheduler lease from no lease, a
 * working socket adapter from a broken one, or a shared rate-limit counter from
 * a per-instance one: in every case one instance produces the correct-looking
 * answer by itself. The failures this feature exists to prevent are precisely
 * the ones that need a second instance to become visible (SC-017 — no guarantee
 * resting on a manual step).
 *
 * The two apps share the SAME `MongoMemoryReplSet` uri and the SAME `REDIS_URL`,
 * which is what makes them two replicas rather than two unrelated systems.
 *
 * Distinct `INSTANCE_ID`s, deliberately: several assertions turn on *which*
 * instance did something, and `configuration.ts` falls back to `hostname()`,
 * which would give both the same value on one machine.
 */
export interface MultiInstanceContext {
  a: INestApplication;
  b: INestApplication;
  replSet: MongoMemoryReplSet;
  /** Base URLs, needed by socket.io-client — it requires a real bound port. */
  urlA: string;
  urlB: string;
  close: () => Promise<void>;
}

export interface MultiInstanceOptions {
  /**
   * Leases are OFF for the ordinary suites (`setup-env.ts`) so a lease held by
   * a crashed app cannot skip an unrelated suite's sweep. Contention is THIS
   * harness's subject, so it defaults to ON here.
   */
  schedulerLeaseEnabled?: boolean;
}

export async function createMultiInstanceApps(
  options: MultiInstanceOptions = {},
): Promise<MultiInstanceContext> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.MONGODB_URI = replSet.getUri('ciro_fuel_multi');
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  process.env.SCHEDULER_LEASE_ENABLED = String(options.schedulerLeaseEnabled ?? true);

  const boot = async (instanceId: string): Promise<INestApplication> => {
    // INSTANCE_ID is read by `configuration()`, which runs when Nest
    // instantiates ConfigModule during compile() — so it must be set HERE, per
    // app, rather than once up front.
    process.env.INSTANCE_ID = instanceId;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    // The same bootstrap production runs, for the same reason the single-app
    // factory calls it (research R1). `registerSignalHandlers: false` because
    // this process boots many apps and a stray signal must not tear down the run.
    configureApp(app, { registerSignalHandlers: false });
    // listen(), not init(): socket.io-client needs a real bound port, and
    // cross-instance realtime delivery is one of the things under test.
    await app.listen(0);
    return app;
  };

  const a = await boot('test-instance-a');
  const b = await boot('test-instance-b');

  return {
    a,
    b,
    replSet,
    urlA: await a.getUrl(),
    urlB: await b.getUrl(),
    close: async () => {
      // Both apps close before the replica set stops — closing the database out
      // from under a live app produces teardown errors that look like test
      // failures.
      await a.close().catch(() => undefined);
      await b.close().catch(() => undefined);
      await replSet.stop().catch(() => undefined);
      delete process.env.INSTANCE_ID;
    },
  };
}
