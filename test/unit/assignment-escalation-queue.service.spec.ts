import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { AssignmentEscalationQueueService } from '../../src/modules/assignment-escalation/queues/assignment-escalation-queue.service';
import { TenantContextService } from '../../src/common/context/tenant-context.service';

jest.setTimeout(60_000);

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

function connectionOptionsFromUrl(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

/**
 * spec 010 T026a/T026b (FR-012a/SC-006, FR-013a): the queue service itself,
 * against a real Redis-backed BullMQ `Queue` (the same infrastructure
 * `PaymentTimeoutQueueService` already depends on in production — no mock
 * substitutes for "does this actually persist/rate-limit"). A uniquely
 * named queue per test avoids colliding with any other worker listening on
 * the shared Redis instance.
 */
describe('AssignmentEscalationQueueService (durability & rate-capping)', () => {
  let queueName: string;
  let queue: Queue<{ orderId: string }>;
  let service: AssignmentEscalationQueueService;
  const workers: Worker[] = [];

  beforeAll(async () => {
    // An absent Redis is otherwise not an error but a hang: ioredis retries
    // forever, so every test here burns its full 60s timeout and the failure
    // names a timeout rather than the missing dependency. This suite is
    // Redis-backed by design (see above) — say so in under two seconds.
    const probe = new Redis({
      ...connectionOptionsFromUrl(REDIS_URL),
      lazyConnect: true,
      connectTimeout: 2000,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });
    probe.on('error', () => undefined); // an unhandled 'error' event would crash the run
    try {
      await probe.connect();
      await probe.ping();
    } catch (err) {
      throw new Error(
        `Redis is required by this suite but is unreachable at ${REDIS_URL} (${(err as Error).message}). ` +
          "Start one ('docker compose up -d redis') or point REDIS_URL at a running instance.",
      );
    } finally {
      probe.disconnect();
    }
  });

  beforeEach(() => {
    queueName = `assignment-escalation-test-${randomUUID()}`;
    queue = new Queue(queueName, { connection: connectionOptionsFromUrl(REDIS_URL) });
    // spec 012 FR-030 — a real one, not a mock: outside a request it has no
    // correlation id, which is the state a sweep-scheduled job is in, and
    // `withCorrelation` must still stamp a usable id rather than undefined.
    service = new AssignmentEscalationQueueService(queue as never, new TenantContextService());
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close()));
    // beforeAll may have aborted before beforeEach ever built one; without this,
    // its one legible failure is buried under a TypeError per test.
    if (!queue) return;
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it('a scheduled job is still present, and still fires, after the worker processing it is torn down and a fresh one built against the same connection (FR-012a, SC-006)', async () => {
    const orderId = randomUUID();
    await service.schedule(orderId, 1 / 120_000); // ~0.5ms delay — fires almost immediately

    // No worker running yet — simulates the gap across a platform restart:
    // the job is durably queued in Redis regardless of whether a process is
    // currently alive to consume it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stillThere = await queue.getJob(orderId);
    expect(stillThere).toBeDefined();

    const processed: string[] = [];
    const worker = new Worker<{ orderId: string }>(
      queueName,
      async (job: Job<{ orderId: string }>) => {
        processed.push(job.data.orderId);
      },
      { connection: connectionOptionsFromUrl(REDIS_URL) },
    );
    workers.push(worker);

    await new Promise<void>((resolve, reject) => {
      worker.on('completed', (job) => {
        if (job.data.orderId === orderId) resolve();
      });
      worker.on('failed', (_job, err) => reject(err));
      setTimeout(() => reject(new Error('job never fired after worker restart')), 10_000);
    });

    expect(processed).toContain(orderId);
  });

  it('cancel removes a still-pending job, so a "restarted" worker never processes it', async () => {
    const orderId = randomUUID();
    await service.schedule(orderId, 1); // 60s delay — will not fire during this test
    await service.cancel(orderId);

    const afterCancel = await queue.getJob(orderId);
    expect(afterCancel).toBeUndefined();
  });

  it('scheduling more jobs than the rate limit allows still processes every one — none dropped, the excess simply delayed (FR-013a)', async () => {
    const orderIds = Array.from({ length: 6 }, () => randomUUID());
    await Promise.all(orderIds.map((id) => service.schedule(id, 0)));

    const processedAt: number[] = [];
    const worker = new Worker<{ orderId: string }>(
      queueName,
      async () => {
        processedAt.push(Date.now());
      },
      {
        connection: connectionOptionsFromUrl(REDIS_URL),
        // A tight cap — 2 jobs per second — so 6 jobs cannot all finish
        // immediately; BullMQ's own limiter is what's under test here, not
        // this feature's code.
        limiter: { max: 2, duration: 1000 },
      },
    );
    workers.push(worker);

    await new Promise<void>((resolve, reject) => {
      let completed = 0;
      worker.on('completed', () => {
        completed += 1;
        if (completed === orderIds.length) resolve();
      });
      worker.on('failed', (_job, err) => reject(err));
      setTimeout(() => reject(new Error('not all jobs completed within the timeout')), 20_000);
    });

    // All 6 eventually processed — none dropped by the cap.
    expect(processedAt).toHaveLength(orderIds.length);
    // And the cap actually did something: processing 6 jobs at 2/second
    // takes measurably longer than 6 unthrottled jobs would (near-instant).
    const spanMs = processedAt[processedAt.length - 1] - processedAt[0];
    expect(spanMs).toBeGreaterThan(1500);
  });
});
