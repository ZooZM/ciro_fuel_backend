import { AccountMovementKind } from './account-movement-kind.enum';

/**
 * spec 017 (operator dashboard) T137/FR-064 — which way the money went in a
 * ledger row, **from the COMPANY's point of view**.
 *
 * The frame matters and is easy to get backwards: `/platform-account/movements`
 * is named for the platform but is read scoped to one company, so a row is
 * described as the party READING it experiences it. SC-011 states the
 * requirement in exactly those terms — a payout must appear in the receiving
 * company's own ledger "identified as incoming". An earlier mapping here was
 * written from the platform's side, which labelled money the company RECEIVED
 * as `OUTBOUND`: coherent in isolation, and the opposite of what the only
 * reader of that ledger means by the word.
 *
 * **Derived in the response, never added to the schema** (research R11). Every
 * movement's direction is already fully determined by its `kind`, so storing it
 * would be a second copy of an existing fact — one that could disagree with the
 * kind after a bad write, and one that would require migrating every existing
 * row to introduce. Deriving it at serialisation means no row migrates and
 * feature 013's dashboard keeps reading every field it already reads.
 *
 * This is what makes Story 8's scenario 6 satisfiable: without it, a cashback
 * the platform paid OUT to a company and a payment that company paid IN are two
 * rows with a positive amount and no visible difference between them (FR-071).
 */
export enum AccountMovementDirection {
  /** Money coming IN to the company — a credit it earned, or a payout it received. */
  INBOUND = 'INBOUND',
  /** Money going OUT of the company — a commission charged to it, or a payment it made. */
  OUTBOUND = 'OUTBOUND',
}

/**
 * Total over `AccountMovementKind`. A kind added later without a direction
 * fails to compile here rather than silently defaulting to `INBOUND` and
 * presenting an outgoing payment as an incoming one.
 */
const DIRECTION_BY_KIND: Record<AccountMovementKind, AccountMovementDirection> = {
  // The platform charges the company: money leaves the company.
  [AccountMovementKind.COMMISSION_CHARGED]: AccountMovementDirection.OUTBOUND,
  // A credit accrued in the company's favour, not yet settled: money owed TO
  // the company, so it points the same way as the payout that will settle it.
  [AccountMovementKind.CASHBACK_CREDITED]: AccountMovementDirection.INBOUND,
  // The company pays the platform: money leaves the company.
  [AccountMovementKind.PAYMENT_RECORDED]: AccountMovementDirection.OUTBOUND,
  // The platform pays the company: money arrives (SC-011's "identified as
  // incoming", read from the receiving company's own ledger).
  [AccountMovementKind.CASHBACK_PAID_OUT]: AccountMovementDirection.INBOUND,
};

export function directionForKind(kind: AccountMovementKind): AccountMovementDirection {
  return DIRECTION_BY_KIND[kind];
}
