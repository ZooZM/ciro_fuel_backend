import { Logger } from '@nestjs/common';

/** Anything with Node's EventEmitter `on` — a BullMQ `Queue` or `Worker`. */
interface ErrorEmitter {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * Attaches an `error` listener to a BullMQ queue or worker — spec 012 Story 9.
 *
 * **This is not tidiness; it is a crash.** BullMQ's `QueueBase` re-emits its
 * Redis connection's errors on the queue/worker itself, and Node's EventEmitter
 * THROWS when an `'error'` event is emitted with no listener attached. So a
 * connection error on a queue nobody is listening to takes the whole process
 * down.
 *
 * Story 9 is what makes that likely rather than theoretical. Redis is now
 * load-bearing for five subsystems, and Clarification Q7 deliberately keeps a
 * Redis-less instance in rotation on the grounds that its loss DEGRADES the
 * platform. An unhandled emitter turns that same loss into an instance crash —
 * so the graceful-degradation design would have been defeated by an
 * EventEmitter default. It surfaced during teardown in
 * `graceful-shutdown.e2e-spec.ts`, where closing the app produces exactly this
 * error against a connection with a blocking read outstanding.
 *
 * Listening is the entire fix: an attached listener makes the event ordinary,
 * and BullMQ reconnects on its own. Recording it matters too — a queue whose
 * Redis is unreachable is silently not processing jobs, and this is the only
 * place that says so.
 */
export function attachQueueErrorHandler(emitter: ErrorEmitter, name: string): void {
  const logger = new Logger(`BullMQ:${name}`);
  emitter.on('error', (err: Error) => {
    // Deliberately not rethrown and not escalated. A queue connection error is
    // a degradation, never a reason to stop serving requests — the platform
    // keeps answering, jobs resume when Redis returns, and the FR-058a
    // sweep-stall alert is what catches a stall that does not resolve.
    logger.warn({ err, queue: name }, 'Queue connection error');
  });
}
