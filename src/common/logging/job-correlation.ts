import { randomUUID } from 'node:crypto';
import { TenantContextService } from '../context/tenant-context.service';

/**
 * Correlation across the queue boundary — spec 012, FR-030.
 *
 * A BullMQ job runs long after the request that enqueued it has returned, on a
 * different tick and possibly a different instance. AsyncLocalStorage does not
 * survive that, so the id has to travel IN THE JOB DATA and be re-established
 * on the other side. Nothing else joins the two halves.
 *
 * **This is the widest-touching and most skippable requirement in the feature.**
 * Done at three enqueue sites and two processors, the platform produces an
 * order history that looks complete — the request records are all there, the
 * job's own records are all there — and is silently missing the link between
 * them. Nobody notices until an incident, when the answer to "what happened
 * after that assignment?" is an empty result rather than an error.
 *
 * Both helpers live here rather than being written out six times so that the
 * key name cannot drift between an enqueue site and the processor that reads
 * it — a drift that also produces no error, just a job whose correlation is
 * `undefined`.
 */

/** The one place the field name is written. */
export const CORRELATION_JOB_FIELD = 'correlationId';

export interface CorrelatedJobData {
  [CORRELATION_JOB_FIELD]?: string;
}

/**
 * Stamps the enqueuing request's correlation id onto job data.
 *
 * Falls back to a fresh id rather than to `undefined`: a job enqueued by a
 * sweep or a script has no request behind it, but its own records still need to
 * be joinable to each other. An absent id would make those records the ones
 * nothing can group.
 */
export function withCorrelation<T extends object>(
  tenantContext: TenantContextService,
  data: T,
): T & CorrelatedJobData {
  return { ...data, [CORRELATION_JOB_FIELD]: tenantContext.getCorrelationId() ?? randomUUID() };
}

/**
 * Re-establishes the id for the duration of a job's processing, so every record
 * the processor emits carries it.
 *
 * Uses the SAME AsyncLocalStorage store the request path uses (research R6), so
 * a processor's records are shaped identically to a request's — no actor, since
 * a job acts as the platform rather than as a user, which is itself the honest
 * representation.
 */
export function runWithJobCorrelation<T>(
  tenantContext: TenantContextService,
  data: CorrelatedJobData | undefined,
  callback: () => T,
): T {
  return tenantContext.runWithCorrelationId(data?.[CORRELATION_JOB_FIELD] ?? randomUUID(), callback);
}
