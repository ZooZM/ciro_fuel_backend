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
  ORDER_STOP_UNRESOLVED = 'ORDER_STOP_UNRESOLVED',

  // feature 013 US5a: to the TRANSPORT COMPANY's admins — the driver reported
  // they cannot reach the destination and stated why. Deliberately NOT
  // `ORDER_STOP_UNRESOLVED`, which means "asked and said nothing" (FR-039a
  // requires the transporter to tell the two apart). Sent immediately, in
  // the same operation that appends the BLOCKED stop; no response window
  // elapses first.
  ORDER_DRIVER_BLOCKED = 'ORDER_DRIVER_BLOCKED',
}
