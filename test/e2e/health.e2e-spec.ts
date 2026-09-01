import request from 'supertest';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';

/**
 * Spec 012 Story 1 (FR-001 – FR-007).
 *
 * The case that matters most is "Redis down → still 200": a 503 there means the
 * correlated-failure trap has been reintroduced, and in production every
 * instance would leave the rotation at the same instant.
 */
describe('Health signals (spec 012 US1)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  }, 60_000);

  describe('GET /health/live', () => {
    it('answers 200 with no credentials and no tenant context (FR-001)', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/live').expect(200);

      expect(res.body.status).toBe('ok');
      expect(typeof res.body.instanceId).toBe('string');
      expect(typeof res.body.uptimeSeconds).toBe('number');
    });

    it('performs no dependency checks, so it cannot fail on a dependency (FR-003)', async () => {
      // Nothing to stop here — the assertion is structural: the response carries
      // no dependency detail at all, which is what keeps an orchestrator from
      // restarting a healthy process during a database incident.
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/live').expect(200);

      expect(res.body).not.toHaveProperty('details');
      expect(res.body).not.toHaveProperty('info');
      expect(res.body).not.toHaveProperty('error');
    });

    it('discloses no tenant data, configuration, secrets or hostname (FR-007)', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/live').expect(200);
      const body = JSON.stringify(res.body);

      expect(Object.keys(res.body).sort()).toEqual(['instanceId', 'status', 'uptimeSeconds']);
      expect(body).not.toContain(process.env.JWT_SECRET);
      expect(body).not.toContain(process.env.MONGODB_URI);
      expect(body).not.toContain(process.env.REDIS_URL);
      expect(body.toLowerCase()).not.toContain('mongodb://');
      expect(body.toLowerCase()).not.toContain('redis://');
    });
  });

  describe('GET /health/ready', () => {
    it('answers 200 with both dependencies up (FR-002)', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.details.mongodb.status).toBe('up');
      expect(res.body.details.redis.status).toBe('up');
      expect(res.body.info.mongodb.status).toBe('up');
    });

    it('reports the verdict in the status code so a proxy need not parse a body (FR-002b)', async () => {
      // 200 vs 503 is the whole contract for the proxy; the body is for
      // monitoring. Asserted here so a future change that moves the verdict
      // into the body alone is caught.
      await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    });

    it('names each dependency in the body for monitoring (FR-006)', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);

      // `rateLimiting` and `realtimeFanout` joined the body in Story 9
      // (FR-063b). They are not extra dependencies — both are Redis-backed
      // CAPABILITIES whose loss is otherwise invisible from outside: rate
      // limiting silently loosens to N× the configured budget while every
      // request still succeeds, and a broken socket adapter is
      // indistinguishable from success from the emitting instance's own
      // vantage point. Neither is disqualifying, for the same reason Redis
      // itself is not (Q7).
      expect(Object.keys(res.body.details).sort()).toEqual([
        'mongodb',
        'rateLimiting',
        'realtimeFanout',
        'redis',
      ]);
    });

    it('discloses no secrets or connection strings (FR-007)', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      const body = JSON.stringify(res.body);

      expect(body).not.toContain(process.env.JWT_SECRET);
      expect(body.toLowerCase()).not.toContain('mongodb://');
      expect(body.toLowerCase()).not.toContain('redis://');
    });
  });

  describe('Redis unreachable — the correlated-failure case (FR-002a, Clarification Q7)', () => {
    // Stubs the client rather than stopping the shared Redis, which other
    // suites in the same --runInBand process depend on.
    let pingSpy: jest.SpyInstance;

    beforeEach(() => {
      const redis = ctx.app.get<{ ping: () => Promise<string> }>(REDIS_CLIENT);
      pingSpy = jest
        .spyOn(redis, 'ping')
        .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    });

    afterEach(() => {
      pingSpy.mockRestore();
    });

    it('STAYS IN ROTATION: answers 200 even though Redis is down', async () => {
      // ⚠ If this ever becomes 503, the correlated-failure trap is back: every
      // instance would go unready at the same instant and nginx would have an
      // empty upstream. A partial degradation converted into a total outage.
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);

      expect(res.body.status).toBe('ok');
    });

    it('reports the degradation in the body so monitoring can see it', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);

      expect(res.body.details.redis.status).toBe('down');
      expect(res.body.error.redis.status).toBe('down');
      expect(res.body.info).not.toHaveProperty('redis');
    });

    it('keeps MongoDB as the sole determinant of the verdict', async () => {
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready').expect(200);

      // status 'ok' WHILE error is non-empty — the deliberate asymmetry.
      expect(res.body.status).toBe('ok');
      expect(res.body.error.redis).toBeDefined();
      expect(res.body.details.mongodb.status).toBe('up');
    });

    it('resolves within the configured bound rather than hanging (FR-006)', async () => {
      const redis = ctx.app.get<{ ping: () => Promise<string> }>(REDIS_CLIENT);
      pingSpy.mockRestore();
      // A ping that never settles must be cut off by the timeout, not left
      // outstanding — a readiness endpoint that hangs looks, to a proxy,
      // exactly like an instance that has died.
      pingSpy = jest.spyOn(redis, 'ping').mockImplementation(() => new Promise(() => {}));

      const started = Date.now();
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready');
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect(res.body.details.redis.status).toBe('down');
      expect(elapsed).toBeLessThan(5_000);
    }, 30_000);
  });

  describe('rate limiting exemption (FR-004)', () => {
    it('never throttles a monitor polling far past the configured limit', async () => {
      // THROTTLE_LIMIT defaults to 100/60s. A monitor polling every 5s for an
      // hour is 720 requests; 150 here is comfortably past the limit and fast.
      const server = ctx.app.getHttpServer();
      const codes = new Set<number>();

      for (let i = 0; i < 150; i += 1) {
        const res = await request(server).get('/api/v1/health/live');
        codes.add(res.status);
      }

      expect([...codes]).toEqual([200]);
    }, 60_000);

    it('does not consume the budget that other routes share', async () => {
      // After 150 unthrottled health probes above, an ordinary unauthenticated
      // route must still answer normally rather than 429 — the probes must not
      // have spent anyone's budget.
      const res = await request(ctx.app.getHttpServer()).get('/api/v1/health/ready');
      expect(res.status).toBe(200);
    });
  });
});
