import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { ShutdownService } from './shutdown.service';
import { TenantContextService } from '../common/context/tenant-context.service';
import { AppIoAdapter } from '../common/realtime/socket-io.adapter';

export interface ConfigureAppOptions {
  /**
   * Register process signal handlers for graceful shutdown. True in production;
   * the e2e factory passes false because it boots ~54 apps in one process — one
   * pair of listeners each would exceed Node's listener cap, and a stray signal
   * would tear down the whole test run rather than one app. The drain gate
   * itself stays testable: a suite calls `ShutdownService.beginDraining()`
   * directly, which is the part with behaviour worth asserting.
   */
  registerSignalHandlers?: boolean;
}

/**
 * THE single place the application is configured — called by BOTH
 * `src/server.ts` and `test/utils/test-app.factory.ts`.
 *
 * Why this file exists (spec 012 research R1, the feature's keystone):
 * `test-app.factory.ts` used to re-implement a subset of `server.ts` by hand,
 * and the two had already drifted — the factory omitted `helmet()` and
 * `enableCors()` entirely. So all 53 e2e suites ran against an application
 * configured differently from the one production runs, and any bootstrap-level
 * behaviour was asserted by nothing.
 *
 * That is precisely the failure mode spec 012 exists to remove, so it must not
 * be reintroduced by spec 012 itself: CORS (Story 3), `trust proxy` (Story 4)
 * and shutdown (Story 2) all land HERE, where the test suites exercise them,
 * rather than in `server.ts` where nothing would.
 *
 * Two deliberate constraints, both load-bearing:
 *   · it MUST NOT call `listen()` — the factory binds its own ephemeral port
 *   · it MUST NOT read `process.env` directly — configuration comes from
 *     `ConfigService`, which the factory can override
 *
 * What stays in `server.ts`: Swagger and the static test console, which are
 * genuinely production-excluded (unlike CORS, which only *looked* like it was).
 */
export function configureApp(app: NestExpressApplication, options: ConfigureAppOptions = {}): void {
  // Structured records (spec 012 Story 5). Routing Nest's own logger through
  // pino is what makes framework output — route mapping, unhandled exceptions,
  // shutdown — the SAME newline-delimited JSON as application output, rather
  // than a second, unparseable stream interleaved with it. It belongs here
  // rather than in `server.ts` for the reason this whole file exists: the e2e
  // suites must exercise the configuration production runs.
  app.useLogger(app.get(PinoLogger));
  app.use(helmet());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // The filter is handed the context service so an unhandled failure is
  // recorded with the correlation id of the request that caused it (FR-034).
  // The response body it produces is unchanged.
  app.useGlobalFilters(new HttpExceptionFilter(app.get(TenantContextService)));

  configureTrustProxy(app);
  configureCors(app);
  // Same allowlist for the realtime namespace, replacing a hardcoded
  // `origin: '*'` that was live in production (FR-014/FR-016). Must be set
  // before `listen()`.
  app.useWebSocketAdapter(new AppIoAdapter(app));

  if (options.registerSignalHandlers ?? true) {
    registerGracefulShutdown(app);
  }
}

/**
 * Client attribution behind a proxy (spec 012 Story 4, FR-021/FR-022).
 *
 * Without this, `req.ip` is the proxy's address for every request, so the
 * platform-wide rate limit collapses into ONE shared budget for every user:
 * one busy client locks out everybody else, and the request record shows a
 * single indistinguishable origin for the whole platform.
 *
 * The hop count has NO default, deliberately. It is 1 when nginx is the only
 * proxy and 2 when a managed load balancer fronts it, and which of those holds
 * is a deployment fact (FR-007d) — checked on 2026-08-31 and currently 1,
 * because no load balancer exists. Guessing wrong is silent: with too few hops
 * the proxy becomes the attributed client for every request, which is the very
 * failure this story exists to fix, and it raises no error.
 *
 * When unset, `trust proxy` is left OFF rather than defaulted, so behaviour
 * stays exactly as it is today instead of being wrong in a new way.
 */
function configureTrustProxy(app: NestExpressApplication): void {
  const hops = app.get(ConfigService).get<number | undefined>('proxy.trustedHops');
  if (hops === undefined) {
    return;
  }
  // nginx must SET, not append to, X-Forwarded-For — `proxy_add_x_forwarded_for`
  // would preserve a client-supplied value and let anyone forge a fresh budget.
  // That single directive is the whole trust boundary (operations-contract §2).
  app.set('trust proxy', hops);
}

/**
 * Cross-origin access (spec 012 Story 3, FR-014 – FR-020).
 *
 * The defect this replaces: `enableCors` lived inside a
 * `NODE_ENV !== 'production'` branch in `server.ts`, alongside Swagger and the
 * static test console. So in production it was never called at all — every
 * browser request from the dashboard was refused before reaching a handler,
 * while the mobile clients (which send no Origin) were unaffected. The symptom
 * looks exactly like an authentication failure and gets diagnosed as one.
 *
 * Now it runs in EVERY environment against an explicit allowlist, and
 * `validation.ts` requires that allowlist to be non-empty in production — the
 * service refuses to start rather than starting with browser access silently
 * broken (FR-018).
 *
 * `origin: []` (empty allowlist, non-production) means the `cors` package
 * matches nothing and reflects no origin, which is the correct closed default:
 * a developer who has not configured origins gets a clear refusal rather than a
 * permissive surprise that then differs from production.
 */
function configureCors(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  const allowedOrigins = config.get<string[]>('cors.allowedOrigins') ?? [];

  app.enableCors({
    // Exact string matching by the `cors` package: scheme, host and port are
    // all significant, and a trailing slash will not match. That is deliberate
    // — a near-miss must fail closed and be diagnosable, never silently permit
    // (spec Edge Cases).
    origin: allowedOrigins,
    // The dashboard sends its access token in an Authorization header and its
    // refresh token in the request body (the deviation recorded in feature
    // 009), so no cookie actually crosses origins today. Kept true so the
    // policy accommodates the existing session mechanism without requiring a
    // change to it (FR-020), and so a future move to a cookie-based refresh
    // does not silently break here.
    credentials: true,
    // A preflight must not be rejected for lacking credentials, and must not
    // consume a rate-limit budget — 204 short-circuits before the handler
    // (FR-017).
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });
}

/**
 * Graceful shutdown (spec 012 Story 2, FR-008 – FR-013).
 *
 * Deliberately does NOT use `app.enableShutdownHooks()`. That helper only adds
 * its own signal listeners which call `app.close()`; the destroy hooks
 * themselves already run on any `close()` (verified in
 * `nest-application-context.js` — `close()` calls `callDestroyHook()`
 * unconditionally). Using it here would register a SECOND listener alongside
 * this one, so the app would be closed twice, and it offers no way to bound the
 * drain. Handling the signal directly gives both things the spec requires and
 * the helper cannot: ordering, and a deadline.
 *
 * The ordering is the whole point. Readiness must go negative BEFORE the server
 * stops accepting connections, so the proxy stops routing new work to an
 * instance that is still able to finish what it already has. Nest's own
 * `OnApplicationShutdown` fires after teardown has begun, which is too late.
 *
 * Sequence:
 *   1. flip the drain gate  → /health/ready answers 503 (FR-005)
 *   2. app.close()          → in-flight requests finish (FR-008), BullMQ workers
 *                             stop fetching and release unfinished jobs for
 *                             redelivery (FR-009), sockets close in an orderly
 *                             way (FR-010), and every module's destroy hook runs
 *                             — including RedisModule's, which until this
 *                             feature had never once executed in production
 *                             because nothing ever called close() on a signal
 *                             (FR-011)
 *   3. exit, or force-exit at the deadline, recorded distinguishably (FR-012)
 */
function registerGracefulShutdown(app: NestExpressApplication): void {
  const logger = new Logger('Shutdown');
  const shutdown = app.get(ShutdownService);
  const config = app.get(ConfigService);
  const drainMs = config.get<number>('shutdown.drainMs') ?? 30_000;

  let closing = false;

  const handle = (signal: NodeJS.Signals): void => {
    // A second signal — an impatient operator, or an orchestrator escalating —
    // must not start a second close.
    if (closing) {
      logger.warn(`Received ${signal} while already draining; ignoring`);
      return;
    }
    closing = true;

    shutdown.beginDraining(signal);

    let forceTimer: NodeJS.Timeout | undefined;
    const forced = new Promise<'forced'>((resolve) => {
      forceTimer = setTimeout(() => resolve('forced'), drainMs);
    });

    void Promise.race([app.close().then(() => 'clean' as const), forced])
      .then((outcome) => {
        if (forceTimer) clearTimeout(forceTimer);
        if (outcome === 'forced') {
          // Recorded distinguishably from a clean exit (FR-012): a forced exit
          // means work was cut off, and an operator needs to be able to tell
          // that from a deploy that drained properly.
          logger.error(
            `Drain deadline of ${drainMs}ms expired after ${shutdown.drainElapsedMs()}ms; ` +
              `forcing exit with work still in flight`,
          );
          process.exit(1);
        }
        logger.log(`Drained cleanly in ${shutdown.drainElapsedMs()}ms; exiting`);
        process.exit(0);
      })
      .catch((err: unknown) => {
        if (forceTimer) clearTimeout(forceTimer);
        logger.error(`Shutdown failed after ${shutdown.drainElapsedMs()}ms: ${String(err)}`);
        process.exit(1);
      });
  };

  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);
}
