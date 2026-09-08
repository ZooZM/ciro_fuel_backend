export enum NotificationType {
  ORDER_APPROVED_FINAL_PRICE = 'ORDER_APPROVED_FINAL_PRICE',
  NO_DRIVER_AVAILABLE = 'NO_DRIVER_AVAILABLE',
  PAYMENT_TIMEOUT = 'PAYMENT_TIMEOUT',
  ORDER_ASSIGNED = 'ORDER_ASSIGNED',
  ORDER_STATUS_CHANGED = 'ORDER_STATUS_CHANGED',
  OTP_ISSUED = 'OTP_ISSUED',
  PAYMENT_RECONCILIATION_REQUIRED = 'PAYMENT_RECONCILIATION_REQUIRED',
  // spec 004 FR-015/US4: an order was routed to a Transportation Company —
  // sent to that transporter's admins, awaiting their driver assignment.
  ORDER_ROUTED_TO_TRANSPORT = 'ORDER_ROUTED_TO_TRANSPORT',
  // spec 005 FR-038b: a client raised a support request — sent to their
  // fuel company's admins via the existing notification path.
  SUPPORT_REQUEST_RAISED = 'SUPPORT_REQUEST_RAISED',

  // spec 011 (in-transit stop detection)
  // To the DRIVER: their truck has not moved for the configured window
  // during the in-transit leg, and the platform is asking why (FR-004).
  // Payload carries `orderId` + `stopId`. This is the one notification type
  // the mobile app raises a *device-level* alert for (FR-004a) — every
  // other type is content for the in-app list, but a driver mid-drive will
  // never look at that list, which is the whole reason this type exists.
  DRIVER_STOP_DETECTED = 'DRIVER_STOP_DETECTED',
  // To the TRANSPORT COMPANY's admins: a detected stop went unanswered past
  // the response window (FR-009) — the driver was asked and said nothing,
  // which is the case most likely to mean they cannot answer.
  ORDER_DRIVER_BLOCKED = 'ORDER_DRIVER_BLOCKED',
  ORDER_STOP_UNRESOLVED = 'ORDER_STOP_UNRESOLVED',


  // spec 013 (fuel company admin dashboard) FR-030 — to the CLIENT (station owner):
  // the outcome of their credit-limit request. Payload carries `accepted` and
  // `grantedAmount` (present only when accepted). One of the two client-facing
  // additions this feature's spec Assumptions name explicitly — the mobile app is
  // otherwise unchanged; a build that has not yet added a case for this value
  // degrades to the existing "unknown" fallback, the same graceful-degradation
  // path every other unrecognised type already has.
  CREDIT_LIMIT_REQUEST_RESOLVED = 'CREDIT_LIMIT_REQUEST_RESOLVED',

  // spec 016 (broadcast fuel exchange offers) — every recipient of these four is a
  // FUEL_COMPANY_ADMIN, so every one is a DASHBOARD notification (research R6). The
  // dashboard is admin-only and no mobile persona ever raises or answers an offer; no
  // mobile surface renders these, and none should be designed for.
  //
  // To every eligible fuel company's administrators when a new offer reaches the
  // market (FR-029). Payload carries `offerId`.
  EXCHANGE_OFFER_AVAILABLE = 'EXCHANGE_OFFER_AVAILABLE',
  // To the raising company's administrators when a recipient proposes or declines
  // (FR-030). Payload carries `offerId`.
  EXCHANGE_PROPOSAL_RECEIVED = 'EXCHANGE_PROPOSAL_RECEIVED',
  // To the WINNING company alone, on award. Payload carries `offerId`.
  EXCHANGE_OFFER_AWARDED = 'EXCHANGE_OFFER_AWARDED',
  // To every OTHER company that had proposed, on award, and to every company that had
  // proposed, on withdrawal (FR-016, FR-030a, FR-031). Deliberately carries NO company
  // name and NO price — a non-winner learns only that the offer closed.
  EXCHANGE_OFFER_CLOSED = 'EXCHANGE_OFFER_CLOSED',
}
