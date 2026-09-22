import { OrderStatus } from '../enums/order-status.enum';

/**
 * spec 017 (operator dashboard) — the six working buckets the platform
 * operator's order screens group the platform's TWELVE order states into
 * (FR-023a, research R3).
 *
 * The mapping is TOTAL and DISJOINT over `OrderStatus`: every state appears
 * in exactly one bucket, so the bucket counts sum to the platform's whole
 * order set with nothing double-counted and nothing unbucketed (FR-023d).
 * `test/unit/order-status-buckets.spec.ts` asserts that against
 * `Object.values(OrderStatus)`, so a thirteenth state added later fails
 * loudly here rather than becoming silently unreachable from the operator's
 * list and absent from every summary card.
 *
 * Both the summary counts (FR-023) and the list filter (FR-016) derive from
 * THIS constant — one mapping, so the home chart and the orders screen cannot
 * drift apart about what "in progress" means (Constitution I).
 */
export enum OrderStatusBucket {
  NEW = 'NEW',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  /**
   * `AWAITING_ROUTING` alone: the one state that cannot progress without a
   * human resolving it, which is the whole purpose of the operator's screen
   * (Clarification 3). Deliberately NOT folded into `NEW`, and `CANCELLED`
   * deliberately NOT folded into `REJECTED` — different actors, different
   * acts (FR-023b, FR-023c).
   */
  NEEDS_ATTENTION = 'NEEDS_ATTENTION',
}

export const ORDER_STATUS_BUCKETS: Readonly<Record<OrderStatusBucket, readonly OrderStatus[]>> = {
  [OrderStatusBucket.NEW]: [
    OrderStatus.PENDING_APPROVAL,
    OrderStatus.APPROVED,
    OrderStatus.ROUTED_TO_TRANSPORT,
    OrderStatus.PENDING_PAYMENT,
  ],
  [OrderStatusBucket.IN_PROGRESS]: [
    OrderStatus.ASSIGNED_TO_DRIVER,
    OrderStatus.LOADING,
    OrderStatus.IN_TRANSIT,
    OrderStatus.UNLOADING,
  ],
  [OrderStatusBucket.COMPLETED]: [OrderStatus.DELIVERED],
  [OrderStatusBucket.REJECTED]: [OrderStatus.REJECTED],
  [OrderStatusBucket.CANCELLED]: [OrderStatus.CANCELLED],
  [OrderStatusBucket.NEEDS_ATTENTION]: [OrderStatus.AWAITING_ROUTING],
} as const;

/**
 * The bucket a single state belongs to. Returns `undefined` only if the
 * mapping has stopped being total, which the exhaustiveness test forbids.
 */
export function bucketForStatus(status: OrderStatus): OrderStatusBucket | undefined {
  return (Object.keys(ORDER_STATUS_BUCKETS) as OrderStatusBucket[]).find((bucket) =>
    ORDER_STATUS_BUCKETS[bucket].includes(status),
  );
}

/** The states of one bucket, for a `status: { $in: [...] }` expansion. */
export function statusesForBucket(bucket: OrderStatusBucket): readonly OrderStatus[] {
  return ORDER_STATUS_BUCKETS[bucket];
}
