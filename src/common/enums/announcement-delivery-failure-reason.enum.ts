/**
 * spec 017 (operator dashboard) T100/FR-054 — why one intended recipient was
 * not reached.
 *
 * **A named reason, never a boolean.** "Not delivered" is not an answer an
 * operator can act on: a suspended company is a business decision they may
 * already know about, a deactivated administrator is an account to reinstate,
 * and a company with no active administrator at all is a gap in onboarding
 * nobody has noticed. Those need three different responses, and a boolean
 * `delivered: false` collapses them into one shrug.
 *
 * A row carrying one of these is recorded as MISSED. It is never counted as
 * delivered, and it carries no `notificationId`.
 */
export enum AnnouncementDeliveryFailureReason {
  /** The recipient's company was suspended by the time the fan-out ran. */
  COMPANY_SUSPENDED = 'COMPANY_SUSPENDED',
  /** The administrator's own account was deactivated. */
  ADMIN_DEACTIVATED = 'ADMIN_DEACTIVATED',
  /**
   * The targeted company has no active administrator at all. Recorded against
   * the company rather than a person, since there is no person to record it
   * against — which is the whole reason it needs its own value.
   */
  NO_ACTIVE_ADMIN = 'NO_ACTIVE_ADMIN',
}
