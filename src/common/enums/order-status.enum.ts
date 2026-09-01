// 9 sequential lifecycle states + 2 terminal states (FR-006; spec 004 adds
// AWAITING_ROUTING and ROUTED_TO_TRANSPORT between APPROVED and
// ASSIGNED_TO_DRIVER — see order-state.service.ts's transition table).
export enum OrderStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  // No Transportation Company serves the client's region (spec 004 FR-016) —
  // held here until a Fuel Company admin resolves it manually.
  AWAITING_ROUTING = 'AWAITING_ROUTING',
  // A transporter has been resolved and notified; awaiting their driver
  // assignment (spec 004 FR-017).
  ROUTED_TO_TRANSPORT = 'ROUTED_TO_TRANSPORT',
  // Awaiting the driver's departure verification (spec 008 FR-046a) — no
  // longer auto-advances to IN_TRANSIT the moment a driver is assigned.
  ASSIGNED_TO_DRIVER = 'ASSIGNED_TO_DRIVER',
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  // The truck has been verified and is en route to (or at) the fuel
  // warehouse, before any fuel has been loaded (spec 008 FR-026, FR-046).
  // Sits between ASSIGNED_TO_DRIVER and IN_TRANSIT — see
  // order-state.service.ts's transition table.
  LOADING = 'LOADING',
  // Narrows to "loaded and travelling to the customer" now that LOADING
  // exists as its own stage (spec 008 FR-046b).
  IN_TRANSIT = 'IN_TRANSIT',
  UNLOADING = 'UNLOADING',
  DELIVERED = 'DELIVERED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}
