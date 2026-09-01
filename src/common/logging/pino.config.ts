import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigService } from '@nestjs/config';
import type { Params } from 'nestjs-pino';
import { TenantContextService } from '../context/tenant-context.service';

/**
 * Structured records — spec 012 Story 5 (FR-025 – FR-035a).
 *
 * The shape is newline-delimited JSON on stdout, collected by the VM's logging
 * agent with fields preserved. That is the whole of FR-028, and it is why
 * `LOG_PRETTY` is forced off in production (see configuration.ts): a
 * human-readable line is a line the collector cannot index, and the retrieval
 * this story exists to enable — "everything that happened to order X" — is a
 * field filter, not a text search.
 */

/**
 * Values that must never reach a record — FR-033.
 *
 * A CONSTANT, deliberately, not a convention. "Do not log secrets" is a rule
 * every contributor agrees with and none can enforce; a redact list is checked
 * by the logger on every record whether or not anyone remembered. The paths are
 * pino's dotted syntax and `[*]` wildcards.
 *
 * `otp` and `code` are here for the same reason as `password`: the delivery-OTP
 * flow (spec 007) puts a live handover code in a request body, and the platform
 * has an explicit rule that it is never rendered on a driver build — logging it
 * would reintroduce exactly that exposure through the back door.
 *
 * Adding a field is cheap and removing one is not, so err towards adding.
 */
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'currentPassword',
  'newPassword',
  'otp',
  '*.otp',
  'code',
  '*.code',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'secret',
  '*.secret',
];

/**
 * pino level → the `severity` string the log service recognises (FR-028a).
 *
 * Without this every record arrives at the collector as the same severity and
 * "show me the errors" returns everything, which is indistinguishable from
 * having no levels at all. pino's numeric `level` is kept alongside it — the
 * two cost nothing together and the numeric one is what local tooling sorts on.
 */
const SEVERITY_BY_LEVEL: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

/** The inbound header honoured as a correlation id when a caller supplies one. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Where the interceptor stashes the request's identifying fields for
 * pino-http to read back.
 *
 * This exists because of a timing fact that is easy to get wrong: pino-http
 * emits its per-request record from `res.on('finish')`, which fires from the
 * socket — OUTSIDE the AsyncLocalStorage scope the interceptor established.
 * So the `mixin` below, which covers every other record, sees nothing at all
 * for this one. Reading these off `req` is what makes the request record carry
 * the same actor and correlation id as the application records inside it,
 * instead of being the one record in the set that cannot be joined to them.
 */
export const LOG_CONTEXT_KEY = 'ciroLogContext';

export interface RequestLogContext {
  correlationId?: string;
  userId?: string;
  companyId?: string;
  role?: string;
}

/**
 * Routes excluded from per-request records — FR-035.
 *
 * The readiness monitor polls every instance every 10 seconds, and nginx's own
 * health location does too: roughly 720 records/hour/instance carrying no
 * diagnostic value whatsoever, in a billable log volume. A FAILING probe is
 * still visible — from the monitor's own output, and from the readiness body.
 */
function isSilentRoute(url: string | undefined): boolean {
  return url !== undefined && url.startsWith('/api/v1/health');
}

export function buildPinoOptions(
  config: ConfigService,
  tenantContext: TenantContextService,
): Params {
  const level = config.get<string>('logging.level') ?? 'info';
  const pretty = config.get<boolean>('logging.pretty') ?? false;
  const instanceId = config.get<string>('health.instanceId')!;

  return {
    pinoHttp: {
      level,

      // Pretty printing is a DEVELOPMENT convenience only. configuration.ts
      // refuses it under NODE_ENV=production regardless of LOG_PRETTY, because
      // a pretty record is one the collector cannot parse into fields.
      transport: pretty
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } }
        : undefined,

      redact: {
        paths: [...REDACTED_PATHS],
        censor: '[REDACTED]',
      },

      formatters: {
        level(label: string, numeric: number) {
          return { level: numeric, severity: SEVERITY_BY_LEVEL[label] ?? 'DEFAULT' };
        },
      },

      // Reuse the id the tenant context already holds, so the per-request
      // record pino-http emits and every application record inside that
      // request carry the SAME id. Generating one here independently would
      // produce two ids for one request, which looks correct in each record
      // and joins nothing.
      genReqId: (req: IncomingMessage) =>
        (req.headers[CORRELATION_ID_HEADER] as string | undefined) ?? randomUUID(),

      /**
       * The fields that make an incident reconstructable (FR-025, FR-031,
       * FR-035a), on EVERY record.
       *
       * `mixin`, not pino-http's `customProps`. This was found by test, and the
       * distinction is the whole of FR-030: `customProps` decorates only the
       * one record pino-http emits when a REQUEST completes. Records written by
       * a BullMQ processor, a scheduled sweep, or any application `Logger` call
       * outside a request never pass through it — so with `customProps` alone,
       * a background job's records carry no correlation id whatsoever, and
       * "everything that happened to this order" silently returns only the
       * request half. The records look complete; the join is missing.
       *
       * `mixin` runs for every record from this logger regardless of what
       * produced it, and reads the SAME AsyncLocalStorage store the scoping
       * plugins use — which is exactly why the correlation id was put in that
       * store rather than a second one (research R6).
       */
      mixin: () => {
        const ctx = tenantContext.getContext();
        // Undefined keys are OMITTED, not emitted. On the request-completion
        // record the store is already gone (see LOG_CONTEXT_KEY), and a mixin
        // returning `correlationId: undefined` there would overwrite the value
        // customProps supplies — turning the fix into the bug it replaced.
        return {
          ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
          ...(ctx?.userId ? { userId: ctx.userId } : {}),
          ...(ctx?.companyId ? { companyId: ctx.companyId } : {}),
          ...(ctx?.role ? { role: ctx.role } : {}),
          instanceId,
        };
      },

      /**
       * Request-only fields. `clientIp` genuinely does not exist for a job or a
       * sweep, so it belongs here rather than in the mixin — an absent field is
       * honest, an empty one invites a wrong conclusion.
       *
       * Correct only because `trust proxy` is set from TRUSTED_PROXY_HOPS
       * (Story 4). Without it this is nginx's address on every record and the
       * whole platform appears to have one client.
       */
      customProps: (req: IncomingMessage) => {
        const stashed =
          (req as unknown as Record<string, RequestLogContext | undefined>)[LOG_CONTEXT_KEY] ?? {};
        return {
          // Falls back to `req.id`, which `genReqId` above set from the inbound
          // header or a fresh uuid — so a request refused before the
          // interceptor ever runs (a rejected preflight, a rate-limited call)
          // still produces a correlated record rather than an orphaned one.
          correlationId: stashed.correlationId ?? (req as { id?: string }).id,
          userId: stashed.userId,
          companyId: stashed.companyId,
          role: stashed.role,
          clientIp: (req as { ip?: string }).ip ?? req.socket?.remoteAddress,
        };
      },

      autoLogging: {
        ignore: (req: IncomingMessage) => isSilentRoute(req.url),
      },

      // One record per completed request, and nothing per successful database
      // operation (FR-035). Mongoose's own debug output is off by default and
      // must stay off: it emits a line per query, which at the tracking
      // stream's rate would dominate the volume and bury the records that
      // matter. Realtime position updates arrive over Socket.io and never
      // reach pino-http at all — deliberately, for the same reason.
      customSuccessMessage: (req: IncomingMessage, res: ServerResponse) =>
        `${req.method} ${req.url} ${res.statusCode}`,
      customErrorMessage: (req: IncomingMessage, res: ServerResponse, err: Error) =>
        `${req.method} ${req.url} ${res.statusCode} ${err.message}`,

      // The default serialisers attach every header. `authorization` is
      // redacted above, but the narrower set below is what actually keeps a
      // request record small enough to be worth retaining.
      serializers: {
        req(req: IncomingMessage & { id?: string; method?: string; url?: string }) {
          return { id: req.id, method: req.method, url: req.url };
        },
        res(res: ServerResponse) {
          return { statusCode: res.statusCode };
        },
      },
    },
  };
}
