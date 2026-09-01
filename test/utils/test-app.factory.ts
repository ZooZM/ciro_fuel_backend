import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap/configure-app';
import { SMS_SENDER, SmsSender } from '../../src/common/sms/sms-sender.port';
import { ResilientThrottlerStorage } from '../../src/common/throttler/resilient-throttler.storage';

/**
 * How long each teardown step may take before the suite gives up on it and
 * moves on (spec 012 T011).
 *
 * Jest's default `afterAll` timeout is 30 s and applies to the WHOLE hook. With
 * 53 sequential apps in one `--runInBand` process, accumulated resource
 * pressure makes `ctx.close()` occasionally exceed that — which reports the
 * suite as failed even though every test in it passed, and a different set of
 * suites is affected each run. Enabling shutdown hooks (T020) makes `close()`
 * do strictly more work, and the multi-instance harness (T098) doubles the apps
 * per test, so both push harder on the same limit.
 *
 * Budgeting each step separately means a slow teardown degrades into a warning
 * rather than a false failure. It deliberately does NOT swallow errors: a
 * genuine throw still propagates.
 */
const TEARDOWN_BUDGET_MS = Number(process.env.TEST_TEARDOWN_BUDGET_MS ?? 12_000);

async function withTeardownBudget(label: string, op: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), TEARDOWN_BUDGET_MS);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([op().then(() => 'done' as const), expiry]);
    if (outcome === 'expired') {
      // eslint-disable-next-line no-console
      console.warn(
        `[test-teardown] ${label} exceeded ${TEARDOWN_BUDGET_MS}ms; continuing so a slow ` +
          `teardown does not fail a suite whose tests all passed`,
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface TestAppContext {
  app: INestApplication;
  replSet: MongoMemoryReplSet;
  /** Base HTTP URL of the actually-listening server — needed by socket.io-client (unlike Supertest, it needs a real bound port). */
  url: string;
  close: () => Promise<void>;
}

/**
 * Boots the full AppModule against a real single-node Mongo replica set
 * (mongodb-memory-server) so multi-document transactions behave exactly as
 * in production, plus a real Redis (REDIS_URL, default localhost — see
 * quickstart.md / CI service container) since BullMQ delayed-job semantics
 * don't hold up against mocks (research.md R12).
 */
export interface TestAppOptions {
  /** Overrides the real `SMS_SENDER` (spec 005 US7) — e.g. a spy that
   * records calls, or one that throws to exercise `SMS_SEND_FAILED`.
   * Omitted, every suite gets the same `NoopSmsSender` as before. */
  smsSender?: SmsSender;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestAppContext> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.MONGODB_URI = replSet.getUri('ciro_fuel_test');
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
  process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-0123456789abcdef';
  process.env.PAYMENT_SADAD_SECRET = 'sadad-test-secret';
  process.env.PAYMENT_MADA_SECRET = 'mada-test-secret';
  process.env.PAYMENT_DEADLINE_MINUTES = process.env.PAYMENT_DEADLINE_MINUTES ?? '30';
  // Spec 012: the suites exercise the local storage adapter and take secrets
  // straight from the environment, so no test needs cloud storage or a secret
  // store (FR-042, FR-048). The production paths remain the ones production uses.
  // NOTE: STORAGE_DRIVER, SECRETS_DRIVER and CORS_ALLOWED_ORIGINS are set in
  // `setup-env.ts`, not here. They must exist BEFORE app.module.ts is imported,
  // because Joi validates process.env at import time and writes the validated
  // result back — by the time this factory runs, an unset variable has already
  // become its Joi default (an empty string, not undefined), so `??=` here
  // would silently fail to override it.

  let builder = Test.createTestingModule({
    imports: [AppModule],
  });
  if (options.smsSender) {
    builder = builder.overrideProvider(SMS_SENDER).useValue(options.smsSender);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  // THE reason this factory exists in its current shape (spec 012 research R1):
  // it used to re-declare versioning/prefix/pipes/filters by hand, and had
  // already drifted from `server.ts` — it omitted `helmet()` and `enableCors()`
  // entirely, so every e2e suite ran against an application configured
  // differently from the one production runs. Call the shared bootstrap; never
  // re-implement any part of it here, or the drift starts over.
  // `registerSignalHandlers: false` — this process boots ~54 apps in sequence,
  // so one pair of SIGTERM/SIGINT listeners each would blow past Node's
  // listener cap, and a stray Ctrl-C would tear down the whole run rather than
  // one app. The drain gate itself stays testable: a suite flips
  // `ShutdownService.beginDraining()` directly, which is the part with
  // behaviour worth asserting (spec 012 T021/T022).
  configureApp(app, { registerSignalHandlers: false });

  // spec 012 T096: rate-limit counters moved into Redis, which is SHARED by
  // every suite in a `--runInBand` run and by every previous run on this
  // machine. The in-memory store each app used to get gave every suite a fresh
  // budget for free; the shared store does not, so without this the 10/min
  // login budget is exhausted within the first few suites and the rest fail
  // with 429s that have nothing to do with what they are testing.
  //
  // Restores the per-app assumption the suites were always written against,
  // and does it HERE so no suite has to remember to.
  await app.get(ResilientThrottlerStorage).reset();
  // listen() (not just init()) so socket.io-client has a real port to connect
  // to — Supertest keeps working identically either way (in-process requests).
  await app.listen(0);
  const url = await app.getUrl();

  return {
    app,
    replSet,
    url,
    close: async () => {
      await withTeardownBudget('app.close()', () => app.close());
      await withTeardownBudget('replSet.stop()', () => replSet.stop());
    },
  };
}
