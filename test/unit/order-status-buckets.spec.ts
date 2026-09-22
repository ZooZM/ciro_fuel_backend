import {
  ORDER_STATUS_BUCKETS,
  OrderStatusBucket,
  bucketForStatus,
  statusesForBucket,
} from '../../src/common/constants/order-status-buckets';
import { OrderStatus } from '../../src/common/enums/order-status.enum';

/**
 * FR-023d: the six buckets must be TOTAL and DISJOINT over `OrderStatus`.
 *
 * This is the test that makes exhaustiveness break loudly. A thirteenth state
 * added to `OrderStatus` without joining a bucket would otherwise be silently
 * unreachable from the operator's list and absent from every summary card,
 * and the six chart segments would quietly stop summing to the total above
 * them (research R3).
 */
describe('ORDER_STATUS_BUCKETS exhaustiveness (FR-023d)', () => {
  const allStatuses = Object.values(OrderStatus);
  const bucketed = Object.values(ORDER_STATUS_BUCKETS).flatMap((s) => [...s]);

  it('covers the platform`s twelve order states, not thirteen', () => {
    // The spec said "thirteen" twice; the enum has twelve. A test written
    // against thirteen would hunt a state that does not exist (research R3).
    expect(allStatuses).toHaveLength(12);
  });

  it('assigns every order state to a bucket — nothing unbucketed', () => {
    expect([...bucketed].sort()).toEqual([...allStatuses].sort());
  });

  it('assigns every order state to exactly ONE bucket — nothing double-counted', () => {
    expect(bucketed).toHaveLength(allStatuses.length);
    expect(new Set(bucketed).size).toBe(bucketed.length);
  });

  it('declares all six buckets', () => {
    expect(Object.keys(ORDER_STATUS_BUCKETS).sort()).toEqual(
      Object.values(OrderStatusBucket).sort(),
    );
  });

  it('keeps REJECTED and CANCELLED separate — different actors, different acts (FR-023b)', () => {
    expect(statusesForBucket(OrderStatusBucket.REJECTED)).toEqual([OrderStatus.REJECTED]);
    expect(statusesForBucket(OrderStatusBucket.CANCELLED)).toEqual([OrderStatus.CANCELLED]);
  });

  it('puts AWAITING_ROUTING under NEEDS_ATTENTION, never NEW (FR-023c)', () => {
    expect(bucketForStatus(OrderStatus.AWAITING_ROUTING)).toBe(OrderStatusBucket.NEEDS_ATTENTION);
    expect(ORDER_STATUS_BUCKETS[OrderStatusBucket.NEW]).not.toContain(OrderStatus.AWAITING_ROUTING);
  });

  it('resolves a bucket for every state via bucketForStatus', () => {
    for (const status of allStatuses) {
      expect(bucketForStatus(status)).toBeDefined();
    }
  });
});
