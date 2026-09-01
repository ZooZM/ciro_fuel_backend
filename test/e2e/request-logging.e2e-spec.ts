import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture, DEFAULT_PASSWORD } from '../utils/fixtures';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import {
  ASSIGNMENT_ESCALATION_QUEUE,
  AssignmentEscalationQueueService,
} from '../../src/modules/assignment-escalation/queues/assignment-escalation-queue.service';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { REDACTED_PATHS } from '../../src/common/logging/pino.config';

jest.setTimeout(180_000);

/**
 * Spec 012 Story 5 (FR-025 – FR-035a, SC-007).
 *
 * The subject of this suite IS the records, so it is the one suite that raises
 * `LOG_LEVEL` — `setup-env.ts` silences logging for the other 50-odd, where
 * per-request JSON would bury the reporter.
 *
 * Records are captured by intercepting `process.stdout.write`, which is where
 * pino's default destination genuinely goes (verified, not assumed). Capturing
 * the real stream rather than injecting a test-only one is deliberate: it means
 * this suite asserts against the bytes production emits, including the
 * serialisers and the redaction, rather than against a parallel path that could
 * differ from it — the same class of drift research R1 found in the bootstrap.
 */
describe('Structured records (spec 012 US5)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;

  let captured: string[] = [];
  let originalWrite: typeof process.stdout.write;

  const records = (): Record<string, unknown>[] =>
    captured
      .join('')
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeAll(async () => {
    process.env.LOG_LEVEL = 'debug';
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
    delete process.env.LOG_LEVEL;
  }, 60_000);

  beforeEach(() => {
    captured = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  /** Records must have settled before assertions — pino's write is async. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

  /** Waits for a record matching `predicate`, up to `timeoutMs`. */
  async function waitForRecord(
    predicate: (r: Record<string, unknown>) => boolean,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = records().find(predicate);
      if (hit) return hit;
      await settle();
    }
    return undefined;
  }

  describe('shape (FR-025, FR-028, FR-028a, FR-031, FR-035a)', () => {
    it('emits newline-delimited JSON that parses, with severity, instance and the acting user', async () => {
      const { client } = fixtures.companyA;
      await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${client.token}`)
        .expect(200);
      await settle();

      const parsed = records();
      expect(parsed.length).toBeGreaterThan(0);

      const requestRecord = parsed.find((r) => String(r.msg ?? '').includes('/api/v1/orders'));
      expect(requestRecord).toBeDefined();

      // FR-028a — a level the collector recognises. Without this every record
      // arrives at the same severity and "show me the errors" returns
      // everything, which is indistinguishable from having no levels at all.
      expect(requestRecord!.severity).toBe('INFO');
      // FR-035a — which instance produced it. With two replicas this is the
      // only thing that answers "is this instance-specific?".
      expect(requestRecord!.instanceId).toBeTruthy();
      // FR-031 — the acting user, read from the same AsyncLocalStorage store
      // the scoping plugins use, so an HTTP record and a job record are shaped
      // alike (research R6).
      expect(requestRecord!.userId).toBe(client.id);
      expect(requestRecord!.companyId).toBe(fixtures.companyA.companyId);
      expect(requestRecord!.role).toBe('CLIENT');
      expect(requestRecord!.correlationId).toBeTruthy();
    });

    it('records an ANONYMOUS request with a correlation id and no actor — and does not fail it', async () => {
      // The regression this pins: public routes now run inside an
      // AsyncLocalStorage store where before they ran in none. Both scoping
      // plugins bypass on the absent `role`; the alternative reading — "a
      // context is present, therefore scope it" — throws
      // "missing companyId" on every single login.
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        // The SUPER_ADMIN, deliberately: spec 006 bumps `sessionGeneration` on
        // every sign-in, so logging in as a fixture user whose token another
        // test in this file still holds would invalidate it and fail that test
        // for a reason that has nothing to do with logging.
        .send({ email: fixtures.superAdmin.email, password: DEFAULT_PASSWORD });
      await settle();

      expect(res.status).toBe(201);

      const loginRecord = records().find((r) => String(r.msg ?? '').includes('/api/v1/auth/login'));
      expect(loginRecord).toBeDefined();
      expect(loginRecord!.correlationId).toBeTruthy();
      expect(loginRecord!.userId).toBeUndefined();
    });

    it('honours an inbound correlation id rather than minting its own (FR-029)', async () => {
      const supplied = randomUUID();
      await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${fixtures.companyA.client.token}`)
        .set('x-correlation-id', supplied)
        .expect(200);
      await settle();

      expect(records().some((r) => r.correlationId === supplied)).toBe(true);
    });

    it('emits NO record for a health probe (FR-035)', async () => {
      // ~720 probes/hour/instance from the readiness monitor alone, carrying no
      // diagnostic value, in a billable volume.
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      await settle();

      expect(records().some((r) => String(r.msg ?? '').includes('/api/v1/health'))).toBe(false);
    });
  });

  describe('one order, one story (FR-030, FR-032, SC-007)', () => {
    it('a request and the background job it enqueues share one correlation id', async () => {
      const correlationId = randomUUID();
      const { client, admin } = fixtures.companyA;

      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${client.token}`)
        .set('x-correlation-id', correlationId)
        .send({ fuelType: 'DIESEL', quantityLiters: 500 })
        .expect(201);
      const orderId = created.body._id as string;

      // Approval is what runs OrderStateService.transition, the one method
      // every status change on the platform passes through.
      await request(app.getHttpServer())
        .patch(`/api/v1/orders/${orderId}/approve`)
        .set('Authorization', `Bearer ${admin.token}`)
        .set('x-correlation-id', correlationId)
        .send({})
        .expect(200);
      await settle();

      const transition = records().find(
        (r) => r.orderId === orderId && r.msg === 'Order status transition',
      );
      expect(transition).toBeDefined();
      // FR-032: `orderId` is a FIELD. A message reading "Order 652f… approved"
      // looks identical in a terminal and is not retrievable by
      // `jsonPayload.orderId`, which is how an incident is actually
      // investigated. This assertion is the difference.
      expect(transition!.orderId).toBe(orderId);
      expect(transition!.correlationId).toBe(correlationId);
    });

    it("an order's history includes records produced by a BACKGROUND JOB, under the same id", async () => {
      // The half of FR-030 that is silently skippable. Enqueued with the
      // request's correlation id in the job DATA — AsyncLocalStorage does not
      // survive the queue, so nothing else joins the two halves. Done wrong,
      // the request records are all present, the job records are all present,
      // and the link between them is missing with no error anywhere.
      const correlationId = randomUUID();
      // Any id: the order will not exist, and the processor records the id it
      // was given either way — which is the field under test.
      const orderId = new Types.ObjectId().toString();
      const queue = app.get(AssignmentEscalationQueueService);
      const tenantContext = app.get(TenantContextService);

      // Redis is SHARED — by every suite in this --runInBand process and by
      // every previous run on this machine, since the queue name is a constant
      // and the database is not namespaced per run. A job left waiting by an
      // earlier suite sits ahead of this one and delays it past any bound,
      // which is exactly how this test failed intermittently before the drain
      // was added. Drained rather than obliterated: obliterate throws while a
      // worker is attached, and the app's real worker is running.
      const rawQueue = app.get<Queue>(getQueueToken(ASSIGNMENT_ESCALATION_QUEUE));
      await rawQueue.drain(true);

      captured = [];
      await tenantContext.runWithCorrelationId(correlationId, () => queue.schedule(orderId, 0));

      // The app's real worker is running, so the real processor picks this up.
      // POLLED, not slept on: a fixed wait is a guess about how loaded the
      // machine is, and this suite runs 58th in a --runInBand process. The
      // assertion is "the record arrives", not "it arrives within 8 seconds".
      const jobRecord = await waitForRecord(
        (r) => r.orderId === orderId && String(r.msg ?? '').startsWith('Assignment escalation'),
      );
      expect(jobRecord).toBeDefined();
      expect(jobRecord!.correlationId).toBe(correlationId);
      expect(jobRecord!.instanceId).toBeTruthy();
    }, 60_000);
  });

  describe('redaction (FR-033)', () => {
    it('never emits a password, an OTP or an Authorization header', async () => {
      const password = DEFAULT_PASSWORD;
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: fixtures.superAdmin.email, password });
      await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${fixtures.companyA.client.token}`);
      await settle();

      const raw = captured.join('');
      expect(raw).not.toContain(password);
      expect(raw).not.toContain(fixtures.companyA.client.token);
    });

    it('keeps redaction a CONSTANT rather than a convention', () => {
      // "Do not log secrets" is a rule every contributor agrees with and none
      // can enforce. A list the logger checks on every record is enforced
      // whether or not anyone remembered — so the list itself is asserted.
      for (const path of ['password', 'otp', 'token', 'req.headers.authorization']) {
        expect(REDACTED_PATHS).toContain(path);
      }
    });
  });
});
